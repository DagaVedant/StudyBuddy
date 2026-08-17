import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { AIProvider, Solution } from '@/lib/ai/types'
import { getMissedQuestions } from '@/lib/blooket/missed'
import { toBlooketCsv } from '@/lib/blooket/csv'
import { questionSolutions, questions } from '@/lib/db/schema'
import { deriveSolutions } from '@/lib/worker/solutions'

import { asDb, createTestDb, type TestDb } from '../helpers/db'
import { makeAttempt, makeQuestion, makeUser, makeWorksheet } from '../helpers/factories'

let db: TestDb
let close: () => Promise<void>

beforeAll(async () => {
  const created = await createTestDb()
  db = created.db
  close = created.close
})

afterAll(async () => {
  await close()
})

const client = () => asDb(db)

function solver(answer: Partial<Solution>): AIProvider {
  return {
    name: 'ollama',
    model: 'test-text-model',
    answeringModel: 'test-model',
    supportsVision: false,
    executionSite: 'operator_gpu',
    extractQuestions: () => {
      throw new Error('deriveSolutions must not extract')
    },
    classifyTopic: () => {
      throw new Error('deriveSolutions must not classify')
    },
    explain: () => {
      throw new Error('deriveSolutions must not explain')
    },
    teachTopic: () => {
      throw new Error('deriveSolutions must not teach')
    },
    answerQuestion: async () => ({
      answer: 'B',
      working: 'Step one, then step two.',
      traps: [{ label: 'A', why: 'Used the diameter.' }],
      confidence: 0.9,
      ...answer,
    }),
  } as unknown as AIProvider
}

const CHOICES = [
  { label: 'A', text: '4', isCorrect: false },
  { label: 'B', text: '6', isCorrect: false },
]

async function paper(spec: { answerSource?: 'none' | 'pdf_key'; correctAnswer?: string } = {}) {
  const userId = await makeUser(db)
  const worksheetId = await makeWorksheet(db, userId)
  const { id } = await makeQuestion(db, userId, worksheetId, { choices: CHOICES })

  if (spec.answerSource === 'pdf_key') {
    await db
      .update(questions)
      .set({ correctAnswer: spec.correctAnswer ?? 'A', answerSource: 'pdf_key' })
      .where(eq(questions.id, id))
  }

  return { userId, worksheetId, questionId: id }
}

const answerOf = async (id: string) =>
  (await db.select().from(questions).where(eq(questions.id, id)))[0]

describe('deriveSolutions', () => {
  it('fills in an answer the paper never had', async () => {
    const { worksheetId, questionId } = await paper()

    const progress = await deriveSolutions(client(), solver({}), worksheetId, { log: null })

    expect(progress).toMatchObject({ solved: 1, promoted: 1, refused: 0, failed: 0 })

    const row = await answerOf(questionId)
    expect(row.correctAnswer).toBe('B')
    expect(row.answerSource).toBe('ai_derived')
  })

  it('stores the working and the traps whether or not it promotes', async () => {
    const { worksheetId, questionId } = await paper()

    await deriveSolutions(client(), solver({}), worksheetId, { log: null })

    const [solution] = await db
      .select()
      .from(questionSolutions)
      .where(eq(questionSolutions.questionId, questionId))

    expect(solution.workingMd).toContain('Step one')
    expect(solution.traps).toEqual([{ label: 'A', why: 'Used the diameter.' }])
    expect(solution.model).toBe('test-model')
  })

  it('never overwrites a key that came off the paper', async () => {
    const { worksheetId, questionId } = await paper({
      answerSource: 'pdf_key',
      correctAnswer: 'A',
    })

    const progress = await deriveSolutions(client(), solver({}), worksheetId, { log: null })

    const row = await answerOf(questionId)
    expect(row.correctAnswer).toBe('A')
    expect(row.answerSource).toBe('pdf_key')
    expect(progress.promoted).toBe(0)
    expect(progress.solved).toBe(1)
  })

  it('records but does not promote an answer the model was unsure of', async () => {
    const { worksheetId, questionId } = await paper()

    const progress = await deriveSolutions(
      client(),
      solver({ confidence: 0.4 }),
      worksheetId,
      { log: null },
    )

    expect(progress.promoted).toBe(0)
    expect((await answerOf(questionId)).answerSource).toBe('none')

    const [solution] = await db
      .select()
      .from(questionSolutions)
      .where(eq(questionSolutions.questionId, questionId))
    expect(solution.workingMd).toContain('Step one')
  })

  it('counts a refusal rather than storing a guess', async () => {
    const { worksheetId, questionId } = await paper()

    const progress = await deriveSolutions(
      client(),
      solver({ answer: null }),
      worksheetId,
      { log: null },
    )

    expect(progress).toMatchObject({ solved: 0, refused: 1, promoted: 0 })
    expect((await answerOf(questionId)).correctAnswer).toBeNull()
  })

  it('skips questions that already have a solution', async () => {
    const { worksheetId } = await paper()

    await deriveSolutions(client(), solver({}), worksheetId, { log: null })
    const second = await deriveSolutions(client(), solver({}), worksheetId, { log: null })

    expect(second).toMatchObject({ solved: 0, promoted: 0, failed: 0 })
  })
})

describe('what a derived answer unlocks', () => {
  it('carries a derived answer into the Blooket export', async () => {
    const { userId, worksheetId, questionId } = await paper()
    await makeAttempt(db, userId, questionId, 'wrong')

    const before = toBlooketCsv(await getMissedQuestions(client(), userId, { worksheetId }))
    expect(before.included).toBe(0)
    expect(before.skipped).toEqual([{ questionId, reason: 'no-answer' }])

    await deriveSolutions(client(), solver({}), worksheetId, { log: null })

    const after = toBlooketCsv(await getMissedQuestions(client(), userId, { worksheetId }))
    expect(after.included).toBe(1)
    expect(after.skipped).toEqual([])
    expect(after.csv).toContain('6')
  })
})
