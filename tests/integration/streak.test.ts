import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getStudyStreak } from '@/lib/dashboard/queries'

import { createTestDb, type TestDb } from '../helpers/db'
import { makeAttempt, makeQuestion, makeUser, makeWorksheet } from '../helpers/factories'

let db: TestDb
let close: () => Promise<void>

beforeAll(async () => {
  const harness = await createTestDb()
  db = harness.db
  close = harness.close
})

afterAll(async () => {
  await close()
})

const NOW = new Date('2026-08-13T15:00:00Z')
function daysAgo(n: number): Date {
  const d = new Date(NOW)
  d.setUTCDate(d.getUTCDate() - n)
  d.setUTCHours(12, 0, 0, 0)
  return d
}

async function attemptOn(userId: string, worksheetId: string, when: Date): Promise<void> {
  const question = await makeQuestion(db, userId, worksheetId)
  await makeAttempt(db, userId, question.id, 'correct', { createdAt: when })
}

describe('getStudyStreak', () => {
  it('counts today and the consecutive days before it', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    for (const n of [0, 1, 2]) await attemptOn(userId, worksheetId, daysAgo(n))

    expect(await getStudyStreak(db, userId, NOW)).toBe(3)
  })

  it('is 0 for an account with no attempts', async () => {
    const userId = await makeUser(db)
    expect(await getStudyStreak(db, userId, NOW)).toBe(0)
  })

  it('stops at the first gap', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    for (const n of [0, 1, 2, 5, 6]) await attemptOn(userId, worksheetId, daysAgo(n))

    expect(await getStudyStreak(db, userId, NOW)).toBe(3)
  })

  it('still counts yesterday when nothing is logged today', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    for (const n of [1, 2, 3]) await attemptOn(userId, worksheetId, daysAgo(n))

    expect(await getStudyStreak(db, userId, NOW)).toBe(3)
  })

  it('is 0 once a full day has passed with nothing logged', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    await attemptOn(userId, worksheetId, daysAgo(2))

    expect(await getStudyStreak(db, userId, NOW)).toBe(0)
  })

  it('counts a day with more than one attempt once', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    const q1 = await makeQuestion(db, userId, worksheetId)
    const q2 = await makeQuestion(db, userId, worksheetId)
    await makeAttempt(db, userId, q1.id, 'correct', { createdAt: daysAgo(0) })
    await makeAttempt(db, userId, q2.id, 'wrong', { createdAt: daysAgo(0) })

    expect(await getStudyStreak(db, userId, NOW)).toBe(1)
  })

  it('never counts another student’s attempts', async () => {
    const mine = await makeUser(db)
    const theirs = await makeUser(db)
    const theirSheet = await makeWorksheet(db, theirs)

    await attemptOn(theirs, theirSheet, daysAgo(0))

    expect(await getStudyStreak(db, mine, NOW)).toBe(0)
  })
})
