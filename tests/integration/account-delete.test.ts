import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { deleteAccount } from '@/lib/account/delete'
import {
  attempts,
  explanations,
  processingJobs,
  questions,
  reviewCards,
  topicProposals,
  userAiCredentials,
  users,
  worksheetPages,
  worksheets,
} from '@/lib/db/schema'

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

async function populated() {
  const userId = await makeUser(db)
  const worksheetId = await makeWorksheet(db, userId)

  const question = await makeQuestion(db, userId, worksheetId, {
    choices: [{ label: 'A', text: '1', isCorrect: true }],
  })
  await makeAttempt(db, userId, question.id, 'wrong')

  await db.insert(worksheetPages).values({
    worksheetId,
    pageNumber: 1,
    imageKey: `${userId}/page-1.webp`,
    width: 100,
    height: 100,
  })

  await db.insert(reviewCards).values({
    userId,
    questionId: question.id,
    dueAt: new Date(),
    stability: 1,
    difficulty: 5,
  })

  await db.insert(explanations).values({
    questionId: question.id,
    bodyMd: 'Because the angles sum to 180.',
  })

  await db.insert(userAiCredentials).values({
    userId,
    provider: 'anthropic',
    keyLast4: '1234',
  })

  await db.insert(processingJobs).values({
    worksheetId,
    userId,
    stage: 'extract',
    executor: 'server',
    status: 'pending',
  })

  return { userId, worksheetId, questionId: question.id }
}

describe('deleteAccount', () => {
  it('takes everything that hangs off the account with it', async () => {
    const { userId, worksheetId, questionId } = await populated()

    await deleteAccount(asDb(db), userId)

    expect(await db.select().from(users).where(eq(users.id, userId))).toEqual([])
    expect(
      await db.select().from(worksheets).where(eq(worksheets.id, worksheetId)),
    ).toEqual([])
    expect(
      await db.select().from(worksheetPages).where(eq(worksheetPages.worksheetId, worksheetId)),
    ).toEqual([])
    expect(await db.select().from(questions).where(eq(questions.id, questionId))).toEqual([])
    expect(await db.select().from(attempts).where(eq(attempts.userId, userId))).toEqual([])
    expect(await db.select().from(reviewCards).where(eq(reviewCards.userId, userId))).toEqual([])
    expect(
      await db.select().from(explanations).where(eq(explanations.questionId, questionId)),
    ).toEqual([])
    expect(
      await db.select().from(userAiCredentials).where(eq(userAiCredentials.userId, userId)),
    ).toEqual([])
    expect(
      await db.select().from(processingJobs).where(eq(processingJobs.userId, userId)),
    ).toEqual([])
  })

  it('reports the page images it had to remove', async () => {
    const { userId } = await populated()

    const result = await deleteAccount(asDb(db), userId)

    expect(result.imagesRemoved + result.imagesFailed).toBe(1)
  })

  it('anonymises a topic proposal instead of deleting it', async () => {
    const { userId } = await populated()

    const [proposal] = await db
      .insert(topicProposals)
      .values({ proposedName: 'Modular arithmetic', userId, status: 'pending' })
      .returning({ id: topicProposals.id })

    await deleteAccount(asDb(db), userId)

    const [after] = await db
      .select()
      .from(topicProposals)
      .where(eq(topicProposals.id, proposal.id))

    expect(after).toBeDefined()
    expect(after.userId).toBeNull()
    expect(after.proposedName).toBe('Modular arithmetic')
  })

  it('leaves another account untouched', async () => {
    const mine = await populated()
    const theirs = await populated()

    await deleteAccount(asDb(db), mine.userId)

    expect(
      await db.select().from(users).where(eq(users.id, theirs.userId)),
    ).toHaveLength(1)
    expect(
      await db.select().from(attempts).where(eq(attempts.userId, theirs.userId)),
    ).toHaveLength(1)
  })
})
