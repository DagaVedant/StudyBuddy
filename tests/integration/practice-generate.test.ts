import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MockProvider } from '@/lib/ai/mock'
import type { AIProvider, GeneratedQuestion, PracticeInput } from '@/lib/ai/types'
import { validated } from '@/lib/ai/validated'
import { getAccountAccuracy, getOverview, getTopicStats } from '@/lib/dashboard/queries'
import {
  answerChoices,
  questionSolutions,
  questionTopics,
  questions,
  reviewCards,
  usageEvents,
  worksheets,
} from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'
import { getMissedQuestions } from '@/lib/blooket/missed'
import { PRACTICE_WORKSHEET_TITLE, generatePractice } from '@/lib/practice/generate'
import { countReviewQueue, getDueCards } from '@/lib/review/queue'

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

const SLOPE = 'high-school-math.algebra-1.linear-functions-and-graphing.slope'

const client = () => db as unknown as Db

const provider = () => validated(new MockProvider())

function stub(questions: GeneratedQuestion[]): AIProvider {
  return validated({
    name: 'mock',
    model: 'stub',
    answeringModel: 'stub',
    supportsVision: false,
    executionSite: 'server',
    extractQuestions: async () => ({ questions: [] }),
    classifyTopic: async () => ({}),
    explain: async () => ({}),
    answerQuestion: async () => ({}),
    teachTopic: async () => ({}),
    writePractice: async (_input: PracticeInput) => ({ questions }),
  })
}

function slopeQuestion(run: number, high: number): GeneratedQuestion {
  const rise = high - 1
  const slope = rise / run

  return {
    prompt_text: `A line passes through (0, 1) and (${run}, ${high}). What is its slope?`,
    choices: [
      { label: 'A', text: String(slope) },
      { label: 'B', text: String(rise) },
      { label: 'C', text: String(run) },
      { label: 'D', text: String(run / rise) },
    ],
    correct_label: 'A',
    working: `Slope is rise over run: (${high} - 1) / (${run} - 0) = ${rise} / ${run} = ${slope}.`,
  }
}

beforeAll(async () => {
  const harness = await createTestDb()
  db = harness.db
  close = harness.close
  topicIds = await seedTaxonomy(db)
})

afterAll(async () => {
  await close()
})

describe('generatePractice', () => {
  it('writes questions into a worksheet of their own', async () => {
    const userId = await makeUser(db)
    const topicId = topicIds.get(SLOPE)!

    const outcome = await generatePractice(client(), provider(), {
      userId,
      topicId,
      count: 3,
      tier: 'cloud',
    })

    expect(outcome.created).toBe(3)

    const [sheet] = await db
      .select()
      .from(worksheets)
      .where(and(eq(worksheets.userId, userId), eq(worksheets.origin, 'generated')))

    expect(sheet.title).toBe(PRACTICE_WORKSHEET_TITLE)
    expect(sheet.sourceType).toBe('generated')

    const written = await db
      .select()
      .from(questions)
      .where(eq(questions.worksheetId, sheet.id))

    expect(written).toHaveLength(3)
    expect(written.every((row) => row.origin === 'generated')).toBe(true)
    expect(written.every((row) => row.answerSource === 'ai_derived')).toBe(true)
    expect(written.map((row) => row.ordinal).sort()).toEqual([1, 2, 3])
  })

  it('reuses the same worksheet on a second run and keeps numbering going', async () => {
    const userId = await makeUser(db)
    const topicId = topicIds.get(SLOPE)!

    await generatePractice(client(), stub([slopeQuestion(2, 7), slopeQuestion(3, 9)]), {
      userId,
      topicId,
      count: 2,
    })
    await generatePractice(client(), stub([slopeQuestion(4, 11), slopeQuestion(5, 13)]), {
      userId,
      topicId,
      count: 2,
    })

    const sheets = await db
      .select()
      .from(worksheets)
      .where(and(eq(worksheets.userId, userId), eq(worksheets.origin, 'generated')))

    expect(sheets).toHaveLength(1)

    const written = await db
      .select({ ordinal: questions.ordinal })
      .from(questions)
      .where(eq(questions.worksheetId, sheets[0].id))

    expect(written.map((row) => row.ordinal).sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
  })

  it('files every question under the topic it was asked for', async () => {
    const userId = await makeUser(db)
    const topicId = topicIds.get(SLOPE)!

    const outcome = await generatePractice(client(), provider(), {
      userId,
      topicId,
      count: 2,
    })

    const tags = await db
      .select()
      .from(questionTopics)
      .where(eq(questionTopics.topicId, topicId))

    const mine = tags.filter((tag) => outcome.questionIds.includes(tag.questionId))

    expect(mine).toHaveLength(2)
    expect(mine.every((tag) => tag.assignedBy === 'ai' && tag.isPrimary)).toBe(true)
  })

  it('stores four options with exactly one marked correct', async () => {
    const userId = await makeUser(db)
    const outcome = await generatePractice(client(), provider(), {
      userId,
      topicId: topicIds.get(SLOPE)!,
      count: 1,
    })

    const choices = await db
      .select()
      .from(answerChoices)
      .where(eq(answerChoices.questionId, outcome.questionIds[0]))

    expect(choices).toHaveLength(4)
    expect(choices.filter((choice) => choice.isCorrect)).toHaveLength(1)
  })

  it('keeps the working so the student sees it afterwards', async () => {
    const userId = await makeUser(db)
    const outcome = await generatePractice(client(), provider(), {
      userId,
      topicId: topicIds.get(SLOPE)!,
      count: 1,
    })

    const [solution] = await db
      .select()
      .from(questionSolutions)
      .where(eq(questionSolutions.questionId, outcome.questionIds[0]))

    expect(solution.workingMd.length).toBeGreaterThan(10)
    expect(solution.derivedAnswer).toBe('A')
  })

  it('records what it spent against the tier that spent it', async () => {
    const userId = await makeUser(db)

    await generatePractice(client(), provider(), {
      userId,
      topicId: topicIds.get(SLOPE)!,
      count: 2,
      tier: 'cloud',
    })

    const [event] = await db
      .select()
      .from(usageEvents)
      .where(and(eq(usageEvents.userId, userId), eq(usageEvents.kind, 'generate_practice')))

    expect(event.quantity).toBe(2)
    expect(event.tierUsed).toBe('cloud')
  })
})

describe('what the validator refuses to store', () => {
  const broken: GeneratedQuestion = {
    prompt_text: 'In the figure above, what is the slope of the line?',
    choices: [
      { label: 'A', text: '2' },
      { label: 'B', text: '3' },
      { label: 'C', text: '4' },
      { label: 'D', text: '5' },
    ],
    correct_label: 'A',
    working: 'Read the two points off the graph and divide the rise by the run.',
  }

  const sound: GeneratedQuestion = {
    prompt_text: 'A line passes through (0, 1) and (2, 7). What is its slope?',
    choices: [
      { label: 'A', text: '3' },
      { label: 'B', text: '4' },
      { label: 'C', text: '6' },
      { label: 'D', text: '1/3' },
    ],
    correct_label: 'A',
    working: 'Slope is rise over run: (7 - 1) / (2 - 0) = 6 / 2 = 3.',
  }

  it('stores the sound one and drops the broken one', async () => {
    const userId = await makeUser(db)

    const outcome = await generatePractice(client(), stub([broken, sound]), {
      userId,
      topicId: topicIds.get(SLOPE)!,
      count: 2,
    })

    expect(outcome.created).toBe(1)
    expect(outcome.rejected).toHaveLength(1)

    const [stored] = await db
      .select({ promptText: questions.promptText })
      .from(questions)
      .where(eq(questions.id, outcome.questionIds[0]))

    expect(stored.promptText).toBe(sound.prompt_text)
  })

  it('stores nothing at all when everything came back broken', async () => {
    const userId = await makeUser(db)

    const outcome = await generatePractice(client(), stub([broken, broken]), {
      userId,
      topicId: topicIds.get(SLOPE)!,
      count: 2,
    })

    expect(outcome.created).toBe(0)
    expect(outcome.questionIds).toEqual([])

    const sheets = await db
      .select()
      .from(worksheets)
      .where(and(eq(worksheets.userId, userId), eq(worksheets.origin, 'generated')))

    expect(sheets).toEqual([])
  })

  it('refuses a question the student already has', async () => {
    const userId = await makeUser(db)
    const topicId = topicIds.get(SLOPE)!

    await generatePractice(client(), stub([sound]), { userId, topicId, count: 1 })

    const again = await generatePractice(client(), stub([sound]), {
      userId,
      topicId,
      count: 1,
    })

    expect(again.created).toBe(0)
    expect(again.rejected[0].flags.map((flag) => flag.code)).toContain(
      'duplicate_of_library',
    )
  })
})

describe('a generated question in the review queue', () => {
  it('is due straight away, with no wrong answer needed first', async () => {
    const userId = await makeUser(db)
    const topicId = topicIds.get(SLOPE)!

    await generatePractice(client(), provider(), { userId, topicId, count: 2 })

    expect(await countReviewQueue(client(), userId)).toBe(2)

    const due = await getDueCards(client(), userId)
    expect(due).toHaveLength(2)
    expect(due[0].answerSource).toBe('ai_derived')
    expect(due[0].choices).toHaveLength(4)
  })

  it('shows up under the topic filter the review page uses', async () => {
    const userId = await makeUser(db)
    const topicId = topicIds.get(SLOPE)!

    await generatePractice(client(), provider(), { userId, topicId, count: 2 })

    expect(await countReviewQueue(client(), userId, new Date(), topicId)).toBe(2)
  })

  it('leaves the queue once it is rated and scheduled forward', async () => {
    const userId = await makeUser(db)
    const topicId = topicIds.get(SLOPE)!

    const outcome = await generatePractice(client(), provider(), {
      userId,
      topicId,
      count: 1,
    })

    await makeAttempt(db, userId, outcome.questionIds[0], 'correct', { source: 'review' })

    const later = new Date(Date.now() + 60_000)

    await db
      .update(reviewCards)
      .set({ dueAt: new Date(Date.now() + 86_400_000) })
      .where(eq(reviewCards.questionId, outcome.questionIds[0]))

    expect(await countReviewQueue(client(), userId, later)).toBe(0)
  })
})

describe('a generated question is kept out of the measured record', () => {
  async function userWithBoth() {
    const userId = await makeUser(db)
    const topicId = topicIds.get(SLOPE)!
    const worksheetId = await makeWorksheet(db, userId)

    const own = await makeQuestion(db, userId, worksheetId, {
      topicId,
      promptText: 'What is the slope of the line through (1, 1) and (3, 5)?',
    })
    await makeAttempt(db, userId, own.id, 'correct')

    const outcome = await generatePractice(client(), provider(), {
      userId,
      topicId,
      count: 2,
    })

    for (const questionId of outcome.questionIds) {
      await makeAttempt(db, userId, questionId, 'wrong', { source: 'review' })
    }

    return { userId, topicId }
  }

  it('does not move the topic accuracy that chose the topic', async () => {
    const { userId, topicId } = await userWithBoth()

    const stats = await getTopicStats(client(), userId)
    const slope = stats.find((row) => row.topicId === topicId)

    expect(slope).toBeDefined()
    expect(slope!.correct).toBe(1)
    expect(slope!.wrong).toBe(0)
  })

  it('does not move the account accuracy', async () => {
    const { userId } = await userWithBoth()

    const accuracy = await getAccountAccuracy(client(), userId)

    expect(accuracy.attempts).toBe(1)
    expect(accuracy.correct).toBe(1)
  })

  it('is not counted as a worksheet the student uploaded', async () => {
    const { userId } = await userWithBoth()

    const overview = await getOverview(client(), userId)

    expect(overview.worksheetsUploaded).toBe(1)
    expect(overview.questionsTracked).toBe(1)
  })

  it('does not reach the Blooket export', async () => {
    const { userId } = await userWithBoth()

    const missed = await getMissedQuestions(client(), userId)

    expect(missed).toEqual([])
  })

  it('is still counted as practice the student did', async () => {
    const { userId } = await userWithBoth()

    const overview = await getOverview(client(), userId)

    expect(overview.attemptsLogged).toBe(3)
  })
})
