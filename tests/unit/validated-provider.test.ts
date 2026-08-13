import { describe, expect, it, vi } from 'vitest'

import { canReview, type PageInput, type RawAIProvider } from '@/lib/ai/types'
import { validated } from '@/lib/ai/validated'

const PAGE: PageInput = {
  image: new Uint8Array(),
  mediaType: 'image/webp',
  text: '',
  width: 100,
  height: 100,
  pageNumber: 1,
}

/** A provider that returns whatever it is told to, checking nothing. */
function raw(replies: Partial<Record<keyof RawAIProvider, unknown>>): RawAIProvider {
  return {
    name: 'mock',
    model: 'mock-1',
    answeringModel: 'mock-answers-1',
    supportsVision: true,
    executionSite: 'server',
    extractQuestions: async () => replies.extractQuestions,
    classifyTopic: async () => replies.classifyTopic,
    explain: async () => replies.explain,
    answerQuestion: async () => replies.answerQuestion,
    teachTopic: async () => replies.teachTopic,
  }
}

describe('validated', () => {
  it('normalises a label the provider never checked', async () => {
    const provider = validated(
      raw({
        extractQuestions: {
          questions: [
            {
              ordinal: 1,
              prompt_text: 'A rectangular garden measures 12 m by 8 m.',
              question_type: 'multiple_choice',
              choices: [
                { label: 'A. 96', text: '96' },
                { label: 'B. 40', text: '40' },
              ],
              bbox: null,
              has_figure: false,
            },
          ],
        },
      }),
    )

    const questions = await provider.extractQuestions(PAGE)

    expect(questions[0].choices.map((choice) => choice.label)).toEqual(['A', 'B'])
  })

  it('drops an unreadable question and says how many it lost', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const provider = validated(
      raw({
        extractQuestions: {
          questions: [
            {
              ordinal: 1,
              prompt_text: 'A genuine question.',
              question_type: 'multiple_choice',
              choices: [],
              bbox: null,
              has_figure: false,
            },
            { ordinal: 2, question_type: 'nonsense' },
          ],
        },
      }),
    )

    const questions = await provider.extractQuestions(PAGE)

    expect(questions).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped 1'))

    warn.mockRestore()
  })

  it('refuses a reply that is not an extraction at all', async () => {
    const provider = validated(raw({ extractQuestions: 'I could not read the page.' }))

    await expect(provider.extractQuestions(PAGE)).resolves.toEqual([])
  })

  it('rejects a classification the provider made up', async () => {
    const provider = validated(raw({ classifyTopic: { nothing: 'useful' } }))

    await expect(
      provider.classifyTopic('Find angle C.', [{ slug: 'g.1', name: 'Angles', path: 'Angles' }]),
    ).rejects.toThrow()
  })

  it('fills in the optional half of a classification', async () => {
    const provider = validated(raw({ classifyTopic: { topic_slug: 'g.1', confidence: 90 } }))

    const result = await provider.classifyTopic('Find angle C.', [])

    // Percentages are folded to the 0-1 range, and the rest take their defaults.
    expect(result).toEqual({
      topic_slug: 'g.1',
      confidence: 0.9,
      abstain: false,
      suggested_name: null,
    })
  })

  it('treats an unreadable review as no opinion rather than a failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const provider = validated({
      ...raw({}),
      reviewQuestions: async () => 'not a review',
    })

    await expect(provider.reviewQuestions?.([])).resolves.toEqual([])

    warn.mockRestore()
  })

  /**
   * Reviewing is its own interface, so "can this provider review" is a
   * narrowing rather than a property check every caller repeats. The compiler
   * now refuses `provider.reviewQuestions` on a provider that cannot, which is
   * the half of this that no test can assert.
   */
  it('does not present a reviewer when the provider cannot review', async () => {
    const provider = validated(raw({}))

    expect(canReview(provider)).toBe(false)
  })

  it('carries the provider identity through unchanged', async () => {
    const provider = validated(raw({}))

    expect(provider.name).toBe('mock')
    // The model separately from the name, because the one caller that stores
    // this used to store the name in both columns.
    expect(provider.model).toBe('mock-1')
    // And the answering model separately again, because a lesson records this
    // one and prints it to the reader. Dropping it here would not fail a type
    // check on the way past: the wrapper builds a fresh object, so a field it
    // forgets is simply undefined by the time a column stores it.
    expect(provider.answeringModel).toBe('mock-answers-1')
    expect(provider.supportsVision).toBe(true)
    expect(provider.executionSite).toBe('server')
  })
})

describe('a bbox the model got wrong', () => {
  async function extractWithBbox(bbox: unknown) {
    const provider = validated(
      raw({
        extractQuestions: {
          questions: [
            {
              ordinal: 1,
              prompt_text: 'What is the area of the shaded region?',
              question_type: 'free_response',
              choices: [],
              bbox,
              has_figure: true,
            },
          ],
        },
      }),
    )

    return provider.extractQuestions(PAGE)
  }

  // The wire schema says "array of numbers" and cannot say four, because
  // neither Anthropic's structured outputs nor Gemini's schema filter take a
  // length. So the wrong length arrives, and the question has to survive it.
  it.each([
    ['too few', [10, 20]],
    ['too many', [10, 20, 30, 40, 50]],
    ['a string among them', [10, 20, 30, '40']],
    ['not an array at all', { x0: 10, y0: 20, x1: 30, y1: 40 }],
    ['unbounded', [10, 20, 30, Infinity]],
  ])('is dropped rather than the question (%s)', async (_case, bbox) => {
    const questions = await extractWithBbox(bbox)

    expect(questions).toHaveLength(1)
    expect(questions[0].prompt_text).toBe('What is the area of the shaded region?')
    expect(questions[0].bbox).toBeNull()
  })

  it('is kept when it is four numbers', async () => {
    const questions = await extractWithBbox([10, 20, 30, 40])

    expect(questions[0].bbox).toEqual([10, 20, 30, 40])
  })
})
