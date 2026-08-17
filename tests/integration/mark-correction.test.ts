import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { attempts, reviewCards } from '@/lib/db/schema'
import { correctMarkupAttempt } from '@/lib/review/correct-mark'
import { scheduleFromOutcome } from '@/lib/review/fsrs'
import { getDueCards } from '@/lib/review/queue'

import { asDb, createTestDb, type TestDb } from '../helpers/db'
import { makeQuestion, makeUser, makeWorksheet } from '../helpers/factories'

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

async function marked(outcome: 'correct' | 'unsure' | 'wrong') {
  const userId = await makeUser(db)
  const worksheetId = await makeWorksheet(db, userId)
  const question = await makeQuestion(db, userId, worksheetId, {
    promptText: 'What is the value of x in this equation?',
    choices: [
      { label: 'A', text: '4', isCorrect: true },
      { label: 'B', text: '7' },
    ],
  })

  await db.insert(attempts).values({
    userId,
    questionId: question.id,
    outcome,
    source: 'markup',
  })

  const { card } = scheduleFromOutcome(null, outcome)
  await db.insert(reviewCards).values({ userId, questionId: question.id, ...card })

  return { userId, worksheetId, question }
}

const markupRows = (userId: string, questionId: string) =>
  db
    .select({ id: attempts.id, outcome: attempts.outcome })
    .from(attempts)
    .where(
      and(
        eq(attempts.userId, userId),
        eq(attempts.questionId, questionId),
        eq(attempts.source, 'markup'),
      ),
    )

describe('correctMarkupAttempt', () => {
  it('brings a question mis-marked correct back into the queue', async () => {
    const { userId, worksheetId, question } = await marked('correct')

    expect(await getDueCards(client(), userId)).toHaveLength(0)

    const result = await correctMarkupAttempt(client(), userId, worksheetId, {
      questionId: question.id,
      outcome: 'wrong',
    })

    expect(result).toMatchObject({ ok: true, outcome: 'wrong' })
    expect(await getDueCards(client(), userId)).toHaveLength(1)
  })

  it('takes one mis-marked wrong back out of it', async () => {
    const { userId, worksheetId, question } = await marked('wrong')

    expect(await getDueCards(client(), userId)).toHaveLength(1)

    await correctMarkupAttempt(client(), userId, worksheetId, {
      questionId: question.id,
      outcome: 'correct',
    })

    expect(await getDueCards(client(), userId)).toHaveLength(0)
  })

  it('updates the attempt rather than writing a second one', async () => {
    const { userId, worksheetId, question } = await marked('correct')

    await correctMarkupAttempt(client(), userId, worksheetId, {
      questionId: question.id,
      outcome: 'wrong',
    })

    const rows = await markupRows(userId, question.id)

    expect(rows).toHaveLength(1)
    expect(rows[0].outcome).toBe('wrong')
  })

  it('records what the student put, and drops it again on a correct', async () => {
    const { userId, worksheetId, question } = await marked('correct')

    await correctMarkupAttempt(client(), userId, worksheetId, {
      questionId: question.id,
      outcome: 'wrong',
      selectedChoiceId: question.choiceIds.B,
    })

    const [item] = await getDueCards(client(), userId)
    expect(item.lastChoiceId).toBe(question.choiceIds.B)

    await correctMarkupAttempt(client(), userId, worksheetId, {
      questionId: question.id,
      outcome: 'correct',
      selectedChoiceId: null,
    })

    const [row] = await db
      .select({ selectedChoiceId: attempts.selectedChoiceId })
      .from(attempts)
      .where(
        and(eq(attempts.userId, userId), eq(attempts.questionId, question.id)),
      )

    expect(row.selectedChoiceId).toBeNull()
  })

  it('refuses a choice belonging to a different question', async () => {
    const { userId, worksheetId, question } = await marked('correct')
    const other = await makeQuestion(db, userId, worksheetId, {
      ordinal: 2,
      promptText: 'What is the slope of the line through these points?',
      choices: [{ label: 'A', text: '2', isCorrect: true }],
    })

    await correctMarkupAttempt(client(), userId, worksheetId, {
      questionId: question.id,
      outcome: 'wrong',
      selectedChoiceId: other.choiceIds.A,
    })

    const [row] = await db
      .select({ selectedChoiceId: attempts.selectedChoiceId })
      .from(attempts)
      .where(
        and(eq(attempts.userId, userId), eq(attempts.questionId, question.id)),
      )

    expect(row.selectedChoiceId).toBeNull()
  })

  describe('the review schedule', () => {
    it('is rebuilt from the corrected outcome when nothing has happened since', async () => {
      const { userId, worksheetId, question } = await marked('correct')

      const [before] = await db
        .select({ dueAt: reviewCards.dueAt })
        .from(reviewCards)
        .where(eq(reviewCards.questionId, question.id))

      const result = await correctMarkupAttempt(client(), userId, worksheetId, {
        questionId: question.id,
        outcome: 'wrong',
      })

      const [after] = await db
        .select({ dueAt: reviewCards.dueAt })
        .from(reviewCards)
        .where(eq(reviewCards.questionId, question.id))

      expect(result).toMatchObject({ rescheduled: true })
      expect(after.dueAt.getTime()).toBeLessThan(before.dueAt.getTime())
    })

    it('is left alone once the student has practised the question', async () => {
      const { userId, worksheetId, question } = await marked('wrong')

      await db.insert(attempts).values({
        userId,
        questionId: question.id,
        outcome: 'correct',
        source: 'review',
      })

      const [before] = await db
        .select({ dueAt: reviewCards.dueAt })
        .from(reviewCards)
        .where(eq(reviewCards.questionId, question.id))

      const result = await correctMarkupAttempt(client(), userId, worksheetId, {
        questionId: question.id,
        outcome: 'correct',
      })

      const [after] = await db
        .select({ dueAt: reviewCards.dueAt })
        .from(reviewCards)
        .where(eq(reviewCards.questionId, question.id))

      expect(result).toMatchObject({ ok: true, rescheduled: false })
      expect(after.dueAt.getTime()).toBe(before.dueAt.getTime())
    })

    it('un-retires a card the student had already put away', async () => {
      const { userId, worksheetId, question } = await marked('correct')
      await db
        .update(reviewCards)
        .set({ retiredAt: new Date() })
        .where(eq(reviewCards.questionId, question.id))

      await correctMarkupAttempt(client(), userId, worksheetId, {
        questionId: question.id,
        outcome: 'wrong',
      })

      expect(await getDueCards(client(), userId)).toHaveLength(1)
    })
  })

  describe('what it refuses', () => {
    it('refuses a question that was never marked', async () => {
      const userId = await makeUser(db)
      const worksheetId = await makeWorksheet(db, userId)
      const question = await makeQuestion(db, userId, worksheetId, {
        promptText: 'What is the value of x in this equation?',
      })

      expect(
        await correctMarkupAttempt(client(), userId, worksheetId, {
          questionId: question.id,
          outcome: 'wrong',
        }),
      ).toEqual({ ok: false, reason: 'not-marked' })
    })

    it('refuses a question on somebody else’s worksheet', async () => {
      const { question } = await marked('correct')
      const stranger = await makeUser(db)
      const theirWorksheet = await makeWorksheet(db, stranger)

      expect(
        await correctMarkupAttempt(client(), stranger, theirWorksheet, {
          questionId: question.id,
          outcome: 'wrong',
        }),
      ).toEqual({ ok: false, reason: 'no-question' })
    })

    it('refuses a question that belongs to a different worksheet', async () => {
      const { userId, question } = await marked('correct')
      const otherWorksheet = await makeWorksheet(db, userId)

      expect(
        await correctMarkupAttempt(client(), userId, otherWorksheet, {
          questionId: question.id,
          outcome: 'wrong',
        }),
      ).toEqual({ ok: false, reason: 'no-question' })
    })
  })
})
