import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { AIProvider } from '@/lib/ai/types'
import {
  EmbeddingUnavailableError,
  classifyWorksheet,
  isEmbedding,
} from '@/lib/classify'
import { questionTopics, questions, topics } from '@/lib/db/schema'
import { EMBEDDING_DIMENSIONS, disposeExtractor, embed } from '@/lib/embeddings'

import { asDb, createTestDb, type TestDb } from '../helpers/db'
import { makeQuestion, makeUser, makeWorksheet, seedTaxonomy } from '../helpers/factories'

let db: TestDb
let close: () => Promise<void>
let slugs: Map<string, string>

const EMBEDDED = [
  'high-school-math.geometry.circles.central-and-inscribed-angles',
  'high-school-math.geometry.circles.arcs-and-chords',
  'high-school-math.algebra-1.foundations.order-of-operations',
]

beforeAll(async () => {
  const created = await createTestDb()
  db = created.db
  close = created.close
  slugs = await seedTaxonomy(db)

  for (const slug of EMBEDDED) {
    const id = slugs.get(slug)
    if (!id) throw new Error(`${slug} is not in the taxonomy any more`)

    await db
      .update(topics)
      .set({ embedding: await embed(slug.split('.').pop()!.replace(/-/g, ' ')) })
      .where(eq(topics.id, id))
  }
})

afterAll(async () => {
  await disposeExtractor()
  await close()
})

const client = () => asDb(db)

const LEAF = 'high-school-math.geometry.circles.central-and-inscribed-angles'

function provider(
  answer: (promptText: string) => unknown,
  calls: string[] = [],
): AIProvider {
  return {
    name: 'mock',
    model: 'test',
    supportsVision: false,
    executionSite: 'server',
    extractQuestions: () => {
      throw new Error('classifyWorksheet must not extract')
    },
    explain: () => {
      throw new Error('classifyWorksheet must not explain')
    },
    classifyTopic: async (promptText: string) => {
      calls.push(promptText)
      const result = answer(promptText)
      if (result instanceof Error) throw result
      return result
    },
  } as unknown as AIProvider
}

async function worksheet(count: number) {
  const userId = await makeUser(db)
  const worksheetId = await makeWorksheet(db, userId)

  const ids: string[] = []
  for (let n = 1; n <= count; n += 1) {
    const { id } = await makeQuestion(db, userId, worksheetId, {
      promptText: `In a circle, what is the measure of inscribed angle number ${n}?`,
      ordinal: n,
    })
    ids.push(id)
  }

  return { userId, worksheetId, ids }
}

const picks = () => ({ topic_slug: LEAF, confidence: 0.9, reason: 'circles' })
const abstains = () => ({ topic_slug: null, confidence: 0.1, reason: 'unsure' })

const tagCount = async (worksheetId: string) =>
  (
    await db
      .select({ id: questionTopics.questionId })
      .from(questionTopics)
      .innerJoin(questions, eq(questionTopics.questionId, questions.id))
      .where(eq(questions.worksheetId, worksheetId))
  ).length

describe('classifyWorksheet', () => {
  it('tags every question and says how many', async () => {
    const { worksheetId } = await worksheet(3)

    const result = await classifyWorksheet(client(), provider(picks), worksheetId)

    expect(result.classified).toBe(3)
    expect(result.failed).toBe(0)
    expect(await tagCount(worksheetId)).toBe(3)
  })

  it('persists the embedding it computed to run the shortlist search', async () => {
    const { worksheetId, ids } = await worksheet(1)

    await classifyWorksheet(client(), provider(picks), worksheetId)

    const [row] = await db
      .select({ embedding: questions.embedding })
      .from(questions)
      .where(eq(questions.id, ids[0]))

    expect(row.embedding).not.toBeNull()
    expect(row.embedding).toHaveLength(EMBEDDING_DIMENSIONS)
  })

  it('persists the embedding even when the question abstains', async () => {
    const { worksheetId, ids } = await worksheet(1)

    await classifyWorksheet(client(), provider(abstains), worksheetId)

    const [row] = await db
      .select({ embedding: questions.embedding })
      .from(questions)
      .where(eq(questions.id, ids[0]))

    expect(row.embedding).not.toBeNull()
  })

  it('reports an abstain as a proposal rather than as a tag', async () => {
    const { worksheetId } = await worksheet(2)

    const result = await classifyWorksheet(client(), provider(abstains), worksheetId)

    expect(result.classified).toBe(0)
    expect(result.coarse).toBe(2)
  })

  it('skips questions that already carry a topic', async () => {
    const { worksheetId } = await worksheet(3)
    await classifyWorksheet(client(), provider(picks), worksheetId)

    const asked: string[] = []
    const result = await classifyWorksheet(client(), provider(picks, asked), worksheetId)

    expect(asked).toEqual([])
    expect(result.classified).toBe(0)
    expect(await tagCount(worksheetId)).toBe(3)
  })

  it('picks up only what is left after a partial run', async () => {
    const { worksheetId, ids } = await worksheet(3)
    await db.insert(questionTopics).values({
      questionId: ids[0],
      topicId: slugs.get(LEAF)!,
      confidence: 0.9,
      assignedBy: 'ai',
    })

    const asked: string[] = []
    const result = await classifyWorksheet(client(), provider(picks, asked), worksheetId)

    expect(asked).toHaveLength(2)
    expect(result.classified).toBe(2)
    expect(await tagCount(worksheetId)).toBe(3)
  })

  it('counts a question the model could not answer and carries on', async () => {
    const { worksheetId } = await worksheet(3)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await classifyWorksheet(
      client(),
      provider((text) => (text.endsWith('2?') ? new Error('unusable') : picks())),
      worksheetId,
    )

    expect(result.failed).toBe(1)
    expect(result.classified).toBe(2)
    expect(await tagCount(worksheetId)).toBe(2)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('stops at the first question when the embedding model will not load', async () => {
    const { worksheetId } = await worksheet(5)
    const asked: string[] = []

    await expect(
      classifyWorksheet(
        client(),
        provider(() => new EmbeddingUnavailableError('no onnxruntime'), asked),
        worksheetId,
      ),
    ).rejects.toBeInstanceOf(EmbeddingUnavailableError)

    expect(asked.length).toBeLessThanOrEqual(1)
    expect(await tagCount(worksheetId)).toBe(0)
  })

  it('is happy with a worksheet that has no questions', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    expect(await classifyWorksheet(client(), provider(picks), worksheetId)).toEqual({
      classified: 0,
      coarse: 0,
      failed: 0,
    })
  })

  it('does not reach into another worksheet', async () => {
    const mine = await worksheet(2)
    const theirs = await worksheet(2)

    await classifyWorksheet(client(), provider(picks), mine.worksheetId)

    expect(await tagCount(mine.worksheetId)).toBe(2)
    expect(await tagCount(theirs.worksheetId)).toBe(0)
  })

  it('narrows the shortlist to the hinted subject', async () => {
    const { worksheetId } = await worksheet(1)
    const asked: string[] = []

    await classifyWorksheet(
      client(),
      provider(picks, asked),
      worksheetId,
      'high-school-math.algebra-1',
    )

    const [tag] = await db
      .select({ topicId: questionTopics.topicId })
      .from(questionTopics)
      .innerJoin(questions, eq(questionTopics.questionId, questions.id))
      .where(eq(questions.worksheetId, worksheetId))

    if (tag) {
      const [topic] = await db
        .select({ slug: topics.slug })
        .from(topics)
        .where(eq(topics.id, tag.topicId))
      expect(topic.slug.startsWith('high-school-math.algebra-1')).toBe(true)
    } else {
      expect(tag).toBeUndefined()
    }
  })
})

describe('isEmbedding', () => {
  const good = new Array(EMBEDDING_DIMENSIONS).fill(0.1)

  it('accepts a vector of the right length', () => {
    expect(isEmbedding(good)).toBe(true)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'vector'],
    ['an object', { 0: 0.1 }],
    ['an empty array', []],
    ['one short', new Array(EMBEDDING_DIMENSIONS - 1).fill(0.1)],
    ['one long', new Array(EMBEDDING_DIMENSIONS + 1).fill(0.1)],
    ['strings of the right length', new Array(EMBEDDING_DIMENSIONS).fill('0.1')],
  ])('rejects %s', (_case, value) => {
    expect(isEmbedding(value)).toBe(false)
  })

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('rejects a vector containing %s', (_case, bad) => {
    const value = [...good]
    value[7] = bad as number

    expect(isEmbedding(value)).toBe(false)
  })
})
