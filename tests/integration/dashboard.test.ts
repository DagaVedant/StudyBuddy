import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  getAccuracyTrend,
  getDistractorPatterns,
  getOverview,
  getRecentWorksheets,
  getTopicStats,
} from '@/lib/dashboard/queries'
import type { Db } from '@/lib/db/types'
import { reviewCards } from '@/lib/db/schema'
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

  /**
   * The worksheets page filtered page furniture out of its counts and the
   * dashboard did not, so the same paper was 25 questions on one screen and 26
   * on the other and nothing told the student which to believe.
   */
  it('counts questions the same way the worksheets page does', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    await makeQuestion(db, userId, worksheetId, {
      promptText: 'What is the area of the shaded region?',
    })
    await makeQuestion(db, userId, worksheetId, { promptText: 'CONTINUE TO THE NEXT PAGE' })
    await makeQuestion(db, userId, worksheetId, { promptText: 'FORM B' })

    const overview = await getOverview(db as Db, userId)

    expect(overview.questionsTracked).toBe(1)
  })

  /**
   * The two tiles describe the review queue, which is the same set the review
   * tab draws from, so a student cannot read one number on the dashboard and
   * find a different one behind the link.
   */
  it('counts the review queue, and the slice of it due today', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    const day = 24 * 3600_000

    // Two overdue, two ahead: all four are in the queue, two are due today.
    for (const offset of [-3 * day, -day, 2 * day, 30 * day]) {
      const q = await makeQuestion(db, userId, worksheetId)
      await makeAttempt(db, userId, q.id, 'wrong')
      await db.insert(reviewCards).values({
        userId,
        questionId: q.id,
        dueAt: new Date(Date.now() + offset),
        stability: 1,
        difficulty: 5,
      })
    }

    // Markup writes a card for every question on the paper, including the ones
    // the student got right. Those were never what this screen is about.
    const known = await makeQuestion(db, userId, worksheetId)
    await makeAttempt(db, userId, known.id, 'correct')
    await db.insert(reviewCards).values({
      userId,
      questionId: known.id,
      dueAt: new Date(Date.now() - day),
      stability: 1,
      difficulty: 5,
    })

    // And one the student has said they have.
    const mastered = await makeQuestion(db, userId, worksheetId)
    await makeAttempt(db, userId, mastered.id, 'wrong')
    await db.insert(reviewCards).values({
      userId,
      questionId: mastered.id,
      dueAt: new Date(Date.now() - day),
      stability: 1,
      difficulty: 5,
      retiredAt: new Date(),
    })

    const overview = await getOverview(db as Db, userId)

    expect(overview.toPractise).toBe(4)
    expect(overview.dueNow).toBe(2)
  })
})

describe('getAccuracyTrend', () => {
  async function withAttemptsAt(weeks: number[]) {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const now = Date.now()

    for (const week of weeks) {
      const q = await makeQuestion(db, userId, worksheetId)
      await makeAttempt(db, userId, q.id, 'wrong', {
        createdAt: new Date(now - week * 7 * 24 * 3600_000),
      })
    }

    return userId
  }

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

    // Counted from the end, because the last bucket is always the current week.
    expect(trend.at(-4)!.wrong).toBe(2)
    expect(trend.at(-2)!.correct).toBe(1)

    const sorted = [...trend].sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    expect(trend.map((p) => p.weekStart)).toEqual(sorted.map((p) => p.weekStart))
  })

  /**
   * The chart draws one bar per row and nothing else, so a row per
   * week-with-attempts made twelve bars read as twelve consecutive weeks
   * whatever they actually were. A student who practised in March and again in
   * June saw two adjacent bars, and a gap during a bad patch closed up into a
   * run of steady work.
   */
  it('returns a row per week, including the ones with nothing in them', async () => {
    const userId = await withAttemptsAt([5, 1])

    const trend = await getAccuracyTrend(db as Db, userId)

    expect(trend).toHaveLength(12)
    expect(trend.at(-6)!.wrong).toBe(1)
    expect(trend.at(-2)!.wrong).toBe(1)

    // Everything between the two is present and empty rather than absent.
    for (const point of trend.slice(-5, -2)) {
      expect(point.correct + point.unsure + point.wrong).toBe(0)
    }
  })

  it('spaces the weeks a week apart, with no gaps to misread', async () => {
    const userId = await withAttemptsAt([2])

    const trend = await getAccuracyTrend(db as Db, userId, 6)

    expect(trend).toHaveLength(6)

    const gaps = trend
      .slice(1)
      .map(
        (point, index) =>
          Date.parse(`${point.weekStart}T00:00:00Z`) -
          Date.parse(`${trend[index].weekStart}T00:00:00Z`),
      )

    expect(new Set(gaps)).toEqual(new Set([7 * 24 * 3600_000]))
  })

  it('still returns the weeks when the student has done nothing at all', async () => {
    const userId = await makeUser(db)

    const trend = await getAccuracyTrend(db as Db, userId, 4)

    expect(trend).toHaveLength(4)
    expect(trend.every((point) => point.correct + point.unsure + point.wrong === 0)).toBe(
      true,
    )
  })
})

describe('getRecentWorksheets', () => {
  it('reports per-worksheet question and miss counts without double counting', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId, 'Unit 4')

    const a = await makeQuestion(db, userId, worksheetId, { ordinal: 1 })
    const b = await makeQuestion(db, userId, worksheetId, { ordinal: 2 })

    // Wrong on the paper, wrong again in review. The count is of wrong answers
    // rather than of questions, so both belong in it; what must not happen is
    // the question itself being counted twice by the join.
    await makeAttempt(db, userId, a.id, 'wrong')
    await makeAttempt(db, userId, a.id, 'wrong', { source: 'review' })
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

    // Picked B on the paper, then picked B again when it came back in review.
    // That repetition is the entire signal this report is looking for.
    await makeAttempt(db, userId, q.id, 'wrong', { selectedChoiceId: q.choiceIds.B })
    await makeAttempt(db, userId, q.id, 'wrong', {
      selectedChoiceId: q.choiceIds.B,
      source: 'review',
    })

    const patterns = await getDistractorPatterns(db as Db, userId)
    const hit = patterns.find((row) => row.questionId === q.id)!

    expect(hit.choiceLabel).toBe('B')
    expect(Number(hit.timesChosen)).toBe(2)
  })
})
