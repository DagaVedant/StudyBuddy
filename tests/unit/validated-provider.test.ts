import { describe, expect, it, vi } from 'vitest'

import type { PageInput, RawAIProvider } from '@/lib/ai/types'
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
    supportsVision: true,
    executionSite: 'server',
    extractQuestions: async () => replies.extractQuestions,
    classifyTopic: async () => replies.classifyTopic,
    explain: async () => replies.explain,
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

  it('leaves reviewQuestions undefined when the provider cannot review', async () => {
    const provider = validated(raw({}))

    expect(provider.reviewQuestions).toBeUndefined()
  })

  it('carries the provider identity through unchanged', async () => {
    const provider = validated(raw({}))

    expect(provider.name).toBe('mock')
    expect(provider.supportsVision).toBe(true)
    expect(provider.executionSite).toBe('server')
  })
})
