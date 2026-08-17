import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'

import type { Tier } from '@/lib/ai/resolve'
import { storedProvider } from '@/lib/ai/stored-provider'
import type { AIProvider, GeneratedQuestion } from '@/lib/ai/types'
import {
  answerChoices,
  attempts,
  questionSolutions,
  questionTopics,
  questions,
  reviewCards,
  topics,
  usageEvents,
  worksheets,
} from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'
import { hashQuestion } from '@/lib/questions/shape'
import { pathBySlug } from '@/lib/taxonomy/trees'

import { siftPractice, type PracticeFlag } from './validate'

export const PRACTICE_BATCH = 4

export const PRACTICE_BATCH_MAX = 8

export const PRACTICE_WORKSHEET_TITLE = 'Practice written for you'

const SAMPLES_SHOWN = 6

const OWNED_HASHES = 2000

export interface PracticeRequest {
  userId: string
  topicId: string
  count?: number
  tier?: Tier
}

export interface PracticeOutcome {
  created: number
  rejected: { flags: PracticeFlag[] }[]
  questionIds: string[]
}

async function findPracticeWorksheet(db: Db, userId: string): Promise<string | null> {
  const [existing] = await db
    .select({ id: worksheets.id })
    .from(worksheets)
    .where(and(eq(worksheets.userId, userId), eq(worksheets.origin, 'generated')))
    .limit(1)

  return existing?.id ?? null
}

export async function practiceWorksheetId(db: Db, userId: string): Promise<string> {
  const existing = await findPracticeWorksheet(db, userId)
  if (existing) return existing

  try {
    const [created] = await db
      .insert(worksheets)
      .values({
        userId,
        title: PRACTICE_WORKSHEET_TITLE,
        sourceType: 'generated',
        origin: 'generated',
        pageCount: 0,
        status: 'ready',
      })
      .returning({ id: worksheets.id })

    return created.id
  } catch (error) {
    const raced = await findPracticeWorksheet(db, userId)
    if (raced) return raced

    throw error
  }
}

async function ownedStems(db: Db, userId: string, topicId: string): Promise<string[]> {
  const rows = await db
    .select({ promptText: questions.promptText })
    .from(questions)
    .innerJoin(questionTopics, eq(questionTopics.questionId, questions.id))
    .where(
      and(
        eq(questions.userId, userId),
        eq(questionTopics.topicId, topicId),
        eq(questions.origin, 'extracted'),
      ),
    )
    .orderBy(
      desc(sql`exists (
        select 1 from ${attempts}
        where ${attempts.questionId} = ${questions.id}
          and ${attempts.userId} = ${userId}
          and ${attempts.outcome} in ('wrong', 'unsure')
      )`),
      desc(questions.createdAt),
    )
    .limit(SAMPLES_SHOWN)

  return rows.map((row) => row.promptText)
}

async function ownedHashes(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ contentHash: questions.contentHash })
    .from(questions)
    .where(and(eq(questions.userId, userId), isNotNull(questions.contentHash)))
    .orderBy(desc(questions.createdAt))
    .limit(OWNED_HASHES)

  return rows.map((row) => row.contentHash).filter((hash) => hash !== null)
}

export async function generatePractice(
  db: Db,
  provider: AIProvider,
  request: PracticeRequest,
): Promise<PracticeOutcome> {
  const count = Math.max(1, Math.min(request.count ?? PRACTICE_BATCH, PRACTICE_BATCH_MAX))

  const [topic] = await db
    .select({ name: topics.name, slug: topics.slug })
    .from(topics)
    .where(eq(topics.id, request.topicId))
    .limit(1)

  if (!topic) throw new Error(`No topic ${request.topicId}`)

  const [samples, hashes] = await Promise.all([
    ownedStems(db, request.userId, request.topicId),
    ownedHashes(db, request.userId),
  ])

  const written = await provider.writePractice({
    topicName: topic.name,
    topicPath: pathBySlug().get(topic.slug) ?? topic.name,
    owned: samples,
    count,
  })

  const { kept, rejected } = siftPractice(written.slice(0, count), hashes)

  if (kept.length === 0) {
    return { created: 0, rejected: rejected.map(({ flags }) => ({ flags })), questionIds: [] }
  }

  const questionIds = await store(db, provider, request, kept)

  return {
    created: questionIds.length,
    rejected: rejected.map(({ flags }) => ({ flags })),
    questionIds,
  }
}

async function store(
  db: Db,
  provider: AIProvider,
  request: PracticeRequest,
  written: GeneratedQuestion[],
): Promise<string[]> {
  const worksheetId = await practiceWorksheetId(db, request.userId)

  const [highest] = await db
    .select({ ordinal: sql<number>`coalesce(max(${questions.ordinal}), 0)::int` })
    .from(questions)
    .where(eq(questions.worksheetId, worksheetId))

  const from = Number(highest?.ordinal ?? 0)
  const now = new Date()

  return db.transaction(async (tx) => {
    const created: string[] = []

    for (const [index, question] of written.entries()) {
      const [row] = await tx
        .insert(questions)
        .values({
          userId: request.userId,
          worksheetId,
          ordinal: from + index + 1,
          promptText: question.prompt_text,
          questionType: 'multiple_choice',
          origin: 'generated',
          correctAnswer: question.correct_label,
          answerSource: 'ai_derived',
          userVerified: false,
          contentHash: hashQuestion(question.prompt_text, question.choices),
        })
        .returning({ id: questions.id })

      await tx.insert(answerChoices).values(
        question.choices.map((choice) => ({
          questionId: row.id,
          label: choice.label,
          text: choice.text,
          isCorrect: choice.label.toUpperCase() === question.correct_label.toUpperCase(),
        })),
      )

      await tx.insert(questionTopics).values({
        questionId: row.id,
        topicId: request.topicId,
        assignedBy: 'ai',
        isPrimary: true,
        confidence: 1,
      })

      if (question.working) {
        await tx.insert(questionSolutions).values({
          questionId: row.id,
          derivedAnswer: question.correct_label,
          workingMd: question.working,
          provider: storedProvider(provider.name),
          model: provider.answeringModel,
        })
      }

      await tx.insert(reviewCards).values({
        userId: request.userId,
        questionId: row.id,
        dueAt: now,
      })

      created.push(row.id)
    }

    await tx.insert(usageEvents).values({
      userId: request.userId,
      kind: 'generate_practice',
      provider: storedProvider(provider.name),
      tierUsed: request.tier ?? null,
      quantity: created.length,
    })

    return created
  })
}

export async function countGenerated(
  db: Db,
  userId: string,
  topicId?: string,
): Promise<number> {
  const query = db
    .select({ value: sql<number>`count(*)::int` })
    .from(questions)
    .where(and(eq(questions.userId, userId), eq(questions.origin, 'generated')))

  if (!topicId) {
    const [row] = await query
    return Number(row?.value ?? 0)
  }

  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(questions)
    .innerJoin(questionTopics, eq(questionTopics.questionId, questions.id))
    .where(
      and(
        eq(questions.userId, userId),
        eq(questions.origin, 'generated'),
        eq(questionTopics.topicId, topicId),
      ),
    )

  return Number(row?.value ?? 0)
}
