import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  getAccuracyTrend,
  getAccuracyTrendBySubject,
  getDistractorPatterns,
  getOverview,
  getRecentWorksheets,
  getReviewForecast,
  getTopicStats,
  listUntaggedWorksheets,
} from '@/lib/dashboard/queries'
import type { Db } from '@/lib/db/types'
import { attempts, reviewCards, worksheets } from '@/lib/db/schema'
import { scheduleFromOutcome } from '@/lib/review/fsrs'
import { UNTAGGED_REASON, recordUntagged } from '@/lib/worker/untagged'
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

  it('counts the review queue, and the slice of it due today', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    const day = 24 * 3600_000

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

    const known = await makeQuestion(db, userId, worksheetId)
    await makeAttempt(db, userId, known.id, 'correct')
    await db.insert(reviewCards).values({
      userId,
      questionId: known.id,
      dueAt: new Date(Date.now() - day),
      stability: 1,
      difficulty: 5,
    })

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

    expect(trend.at(-4)!.wrong).toBe(2)
    expect(trend.at(-2)!.correct).toBe(1)

    const sorted = [...trend].sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    expect(trend.map((p) => p.weekStart)).toEqual(sorted.map((p) => p.weekStart))
  })

  it('returns a row per week, including the ones with nothing in them', async () => {
    const userId = await withAttemptsAt([5, 1])

    const trend = await getAccuracyTrend(db as Db, userId)

    expect(trend).toHaveLength(12)
    expect(trend.at(-6)!.wrong).toBe(1)
    expect(trend.at(-2)!.wrong).toBe(1)

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

describe('the panels that were missing', () => {
  describe('getReviewForecast', () => {
    it('breaks what is due down by topic', async () => {
      const userId = await makeUser(db)
      const worksheetId = await makeWorksheet(db, userId)
      const triangles = topicIds.get(TRIANGLES)!
      const slope = topicIds.get(SLOPE)!

      const overdue = new Date(Date.now() - 60_000)
      let ordinal = 0
      for (const topicId of [triangles, triangles, slope]) {
        ordinal += 1
        const question = await makeQuestion(db, userId, worksheetId, {
          ordinal,
          promptText: 'What is the value of x in this equation?',
          topicId,
        })
        await makeAttempt(db, userId, question.id, 'wrong')
        const { card } = scheduleFromOutcome(null, 'wrong')
        await db
          .insert(reviewCards)
          .values({ userId, questionId: question.id, ...card, dueAt: overdue })
      }

      const forecast = await getReviewForecast(db as Db, userId)

      expect(forecast[0]).toMatchObject({ dueToday: 2 })
      expect(forecast.map((row) => row.dueToday)).toEqual([2, 1])
    })

    it('leaves out what is not due within the week', async () => {
      const userId = await makeUser(db)
      const worksheetId = await makeWorksheet(db, userId)
      const question = await makeQuestion(db, userId, worksheetId, {
        promptText: 'What is the value of x in this equation?',
        topicId: topicIds.get(TRIANGLES)!,
      })
      await makeAttempt(db, userId, question.id, 'wrong')

      const { card } = scheduleFromOutcome(null, 'wrong')
      const nextMonth = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      await db
        .insert(reviewCards)
        .values({ userId, questionId: question.id, ...card, dueAt: nextMonth })

      expect(await getReviewForecast(db as Db, userId)).toEqual([])
    })
  })

  describe('the trend arrow', () => {
    async function topicWithHistory(outcomes: ('correct' | 'wrong')[]) {
      const userId = await makeUser(db)
      const worksheetId = await makeWorksheet(db, userId)

      let ordinal = 0
      for (const outcome of outcomes) {
        ordinal += 1
        const question = await makeQuestion(db, userId, worksheetId, {
          ordinal,
          promptText: 'What is the value of x in this equation?',
          topicId: topicIds.get(TRIANGLES)!,
        })
        await db.insert(attempts).values({
          userId,
          questionId: question.id,
          outcome,
          source: 'markup',
          createdAt: new Date(Date.now() - (outcomes.length - ordinal) * 60_000),
        })
      }

      const stats = await getTopicStats(db as Db, userId)
      return stats.find((row) => row.topicId === topicIds.get(TRIANGLES)!)!
    }

    it('points up when the later half went better', async () => {
      expect(
        (await topicWithHistory(['wrong', 'wrong', 'correct', 'correct'])).trend,
      ).toBe('up')
    })

    it('points down when it went worse', async () => {
      expect(
        (await topicWithHistory(['correct', 'correct', 'wrong', 'wrong'])).trend,
      ).toBe('down')
    })

    it('stays flat for a wobble rather than calling it a direction', async () => {
      expect(
        (await topicWithHistory(['correct', 'wrong', 'correct', 'wrong'])).trend,
      ).toBe('flat')
    })

    it('says nothing at all with a single attempt', async () => {
      expect((await topicWithHistory(['wrong'])).trend).toBeNull()
    })
  })

  describe('getAccuracyTrendBySubject', () => {
    it('reports one series per subject the student has attempted', async () => {
      const userId = await makeUser(db)
      const worksheetId = await makeWorksheet(db, userId)

      let ordinal = 0
      for (const topicId of [topicIds.get(TRIANGLES)!, topicIds.get(SLOPE)!]) {
        ordinal += 1
        const question = await makeQuestion(db, userId, worksheetId, {
          ordinal,
          promptText: 'What is the value of x in this equation?',
          topicId,
        })
        await makeAttempt(db, userId, question.id, 'wrong')
      }

      const series = await getAccuracyTrendBySubject(db as Db, userId, 4)

      expect(series).toHaveLength(1)
      expect(series[0].points).toHaveLength(4)
      expect(series[0].points.at(-1)?.wrong).toBe(2)
    })

    it('reports nothing for an account with no attempts', async () => {
      const userId = await makeUser(db)

      expect(await getAccuracyTrendBySubject(db as Db, userId, 4)).toEqual([])
    })
  })

  describe('getRecentWorksheets', () => {
    it('carries the score and the topics the paper covered', async () => {
      const userId = await makeUser(db)
      const worksheetId = await makeWorksheet(db, userId)

      const right = await makeQuestion(db, userId, worksheetId, {
        ordinal: 1,
        promptText: 'What is the value of x in this equation?',
        topicId: topicIds.get(TRIANGLES)!,
      })
      const missed = await makeQuestion(db, userId, worksheetId, {
        ordinal: 2,
        promptText: 'What is the slope of the line through these points?',
        topicId: topicIds.get(SLOPE)!,
      })

      await makeAttempt(db, userId, right.id, 'correct')
      await makeAttempt(db, userId, missed.id, 'wrong')

      const [sheet] = await getRecentWorksheets(db as Db, userId)

      expect(sheet).toMatchObject({ markedCount: 2, correctCount: 1, wrongCount: 1 })
      expect(sheet.topics.map((topic) => topic.topicName).sort()).toEqual(
        ['Slope', 'Triangle angle sum'].sort(),
      )
    })
  })
})

describe('listUntaggedWorksheets', () => {
  it('lists the worksheets that finished with no topics', async () => {
    const userId = await makeUser(db)
    const untagged = await makeWorksheet(db, userId)
    await makeWorksheet(db, userId)

    expect(await listUntaggedWorksheets(db as Db, userId)).toHaveLength(0)

    await db
      .update(worksheets)
      .set({ classificationError: UNTAGGED_REASON.classifierDown })
      .where(eq(worksheets.id, untagged))

    expect(await listUntaggedWorksheets(db as Db, userId)).toHaveLength(1)
  })

  it('lists only this student’s', async () => {
    const mine = await makeUser(db)
    const theirs = await makeUser(db)
    const theirSheet = await makeWorksheet(db, theirs)

    await db
      .update(worksheets)
      .set({ classificationError: UNTAGGED_REASON.classifierDown })
      .where(eq(worksheets.id, theirSheet))

    expect(await listUntaggedWorksheets(db as Db, mine)).toHaveLength(0)
  })

  it('reads the same column Tier C writes when it finishes', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    await recordUntagged(db as Db, worksheetId, UNTAGGED_REASON.tierCUnsupported)

    expect(await listUntaggedWorksheets(db as Db, userId)).toHaveLength(1)

    const [row] = await db
      .select({ reason: worksheets.classificationError })
      .from(worksheets)
      .where(eq(worksheets.id, worksheetId))

    expect(row.reason).toMatch(/does not sort questions into topics yet/)
  })
})
