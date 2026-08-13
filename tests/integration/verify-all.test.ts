import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { questions } from '@/lib/db/schema'
import { unverifyQuestions, verifyRemaining } from '@/lib/questions/verify-all'

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

/** The factory always makes a verified question; this is the unverified one. */
async function unverified(userId: string, worksheetId: string): Promise<string> {
  const question = await makeQuestion(db, userId, worksheetId)
  await db.update(questions).set({ userVerified: false }).where(eq(questions.id, question.id))
  return question.id
}

async function verifiedStatus(id: string): Promise<boolean> {
  const [row] = await db.select({ userVerified: questions.userVerified }).from(questions).where(eq(questions.id, id))
  return row.userVerified
}

describe('verifyRemaining', () => {
  it('verifies every unverified question on the worksheet', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const a = await unverified(userId, worksheetId)
    const b = await unverified(userId, worksheetId)

    const ids = await verifyRemaining(client(), worksheetId)

    expect(new Set(ids)).toEqual(new Set([a, b]))
    expect(await verifiedStatus(a)).toBe(true)
    expect(await verifiedStatus(b)).toBe(true)
  })

  it('skips ids the caller excludes', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const keep = await unverified(userId, worksheetId)
    const accept = await unverified(userId, worksheetId)

    const ids = await verifyRemaining(client(), worksheetId, [keep])

    expect(ids).toEqual([accept])
    expect(await verifiedStatus(keep)).toBe(false)
    expect(await verifiedStatus(accept)).toBe(true)
  })

  it('never touches another worksheet', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const otherSheet = await makeWorksheet(db, userId)
    const foreign = await unverified(userId, otherSheet)

    await verifyRemaining(client(), worksheetId)

    expect(await verifiedStatus(foreign)).toBe(false)
  })

  it('does not re-touch a question already verified', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    // The factory's own default: already verified.
    const already = (await makeQuestion(db, userId, worksheetId)).id

    const ids = await verifyRemaining(client(), worksheetId)

    expect(ids).not.toContain(already)
  })
})

describe('unverifyQuestions', () => {
  it('undoes exactly the ids given, and no others', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const undone = await unverified(userId, worksheetId)
    const kept = await unverified(userId, worksheetId)
    await verifyRemaining(client(), worksheetId)

    const reverted = await unverifyQuestions(client(), worksheetId, [undone])

    expect(reverted).toEqual([undone])
    expect(await verifiedStatus(undone)).toBe(false)
    expect(await verifiedStatus(kept)).toBe(true)
  })

  it('never touches another worksheet even if asked to by id', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const otherSheet = await makeWorksheet(db, userId)
    const foreign = await makeQuestion(db, userId, otherSheet) // verified by default

    const reverted = await unverifyQuestions(client(), worksheetId, [foreign.id])

    expect(reverted).toEqual([])
    expect(await verifiedStatus(foreign.id)).toBe(true)
  })
})
