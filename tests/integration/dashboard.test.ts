import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  getAccuracyTrend,
  getDistractorPatterns,
  getOverview,
  getRecentWorksheets,
  getTopicStats,
  type Db,
} from '@/lib/dashboard/queries'
import { rankWeaknesses } from '@/lib/dashboard/ranking'

import { createTestDb, type TestDb } from '../helpers/db'
import {
  makeAttempt,
  makeQuestion,
  makeUser,
  makeWorksheet,
  seedTaxonomy,
} from '../helpers/factories'

let db: TestDb
let close: () => Promise<void>
let topicIds: Map<string, string>

const TRIANGLES = 'high-school-math.geometry.triangles.triangle-angle-sum'
const SLOPE = 'high-school-math.algebra-1.linear-functions-and-graphing.slope'

beforeAll(async () => {
  const harness = await createTestDb()
  db = harness.db
  close = harness.close
  topicIds = await seedTaxonomy(db)
})

afterAll(async () => {
  await close()
})

describe('getTopicStats', () => {
  it('tallies outcomes per topic and ignores other users', async () => {
    const userId = await makeUser(db)
    const otherId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const otherSheet = await makeWorksheet(db, otherId)

    const triangles = topicIds.get(TRIANGLES)!
    const slope = topicIds.get(SLOPE)!

    for (const outcome of ['wrong', 'wrong', 'correct'] as const) {
      const q = await makeQuestion(db, userId, worksheetId, { topicId: triangles })
      await makeAttempt(db, userId, q.id, outcome)
    }

    const slopeQ = await makeQuestion(db, userId, worksheetId, { topicId: slope })
    await makeAttempt(db, userId, slopeQ.id, 'unsure')

    const foreign = await makeQuestion(db, otherId, otherSheet, { topicId: triangles })
    await makeAttempt(db, otherId, foreign.id, 'wrong')

    const stats = await getTopicStats(db as Db, userId)
    const triangleStats = stats.find((row) => row.topicId === triangles)!

    expect(triangleStats.wrong).toBe(2)
    expect(triangleStats.correct).toBe(1)
    expect(triangleStats.unsure).toBe(0)

    const slopeStats = stats.find((row) => row.topicId === slope)!
    expect(slopeStats.unsure).toBe(1)
  })

  it('feeds ranking that survives the low-sample trap end to end', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    const triangles = topicIds.get(TRIANGLES)!
    const slope = topicIds.get(SLOPE)!

    const single = await makeQuestion(db, userId, worksheetId, { topicId: slope })
    await makeAttempt(db, userId, single.id, 'wrong')

    for (let i = 0; i < 12; i += 1) {
      const q = await makeQuestion(db, userId, worksheetId, { topicId: triangles })
      await makeAttempt(db, userId, q.id, i < 8 ? 'wrong' : 'correct')
    }

    const ranked = rankWeaknesses(await getTopicStats(db as Db, userId))

    expect(ranked[0]?.topicId).toBe(triangles)
    expect(ranked.map((row) => row.topicId)).not.toContain(slope)
  })
})

describe('getOverview', () => {
  it('counts only the signed-in student', async () => {
    const userId = await makeUser(db)
    const otherId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    await makeWorksheet(db, otherId)

    const q = await makeQuestion(db, userId, worksheetId)
    await makeAttempt(db, userId, q.id, 'wrong')

    const overview = await getOverview(db as Db, userId)

    expect(overview.worksheetsUploaded).toBe(1)
    expect(overview.questionsTracked).toBe(1)
    expect(overview.attemptsLogged).toBe(1)
  })
})

describe('getAccuracyTrend', () => {
  it('buckets attempts by week in chronological order', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    const now = Date.now()
    const weeksAgo = (n: number) => new Date(now - n * 7 * 24 * 3600_000)

    for (const [week, outcome] of [
      [3, 'wrong'],
      [3, 'wrong'],
      [1, 'correct'],
    ] as const) {
      const q = await makeQuestion(db, userId, worksheetId)
      await makeAttempt(db, userId, q.id, outcome, { createdAt: weeksAgo(week) })
    }

    const trend = await getAccuracyTrend(db as Db, userId)

    expect(trend.length).toBeGreaterThanOrEqual(2)
    expect(trend[0].wrong).toBe(2)
    expect(trend.at(-1)!.correct).toBe(1)

    const sorted = [...trend].sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    expect(trend.map((p) => p.weekStart)).toEqual(sorted.map((p) => p.weekStart))
  })
})

describe('getRecentWorksheets', () => {
  it('reports per-worksheet question and miss counts without double counting', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId, 'Unit 4')

    const a = await makeQuestion(db, userId, worksheetId, { ordinal: 1 })
    const b = await makeQuestion(db, userId, worksheetId, { ordinal: 2 })

    await makeAttempt(db, userId, a.id, 'wrong')
    // A second attempt on the same question must not inflate the question count.
    await makeAttempt(db, userId, a.id, 'wrong')
    await makeAttempt(db, userId, b.id, 'correct')

    const recent = await getRecentWorksheets(db as Db, userId)
    const sheet = recent.find((row) => row.id === worksheetId)!

    expect(sheet.questionCount).toBe(2)
    expect(sheet.wrongCount).toBe(2)
    expect(sheet.title).toBe('Unit 4')
  })
})

describe('getDistractorPatterns', () => {
  it('surfaces a wrong choice the student keeps picking', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    const q = await makeQuestion(db, userId, worksheetId, {
      promptText: 'Find angle C.',
      choices: [
        { label: 'A', text: '75°', isCorrect: true },
        { label: 'B', text: '105°' },
      ],
    })

    await makeAttempt(db, userId, q.id, 'wrong', { selectedChoiceId: q.choiceIds.B })
    await makeAttempt(db, userId, q.id, 'wrong', { selectedChoiceId: q.choiceIds.B })

    const patterns = await getDistractorPatterns(db as Db, userId)
    const hit = patterns.find((row) => row.questionId === q.id)!

    expect(hit.choiceLabel).toBe('B')
    expect(Number(hit.timesChosen)).toBe(2)
  })
})
