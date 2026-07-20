import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { attempts, questions, reviewCards, topics, users, worksheets } from '@/lib/db/schema'
import { scheduleFromOutcome } from '@/lib/review/fsrs'
import { flattenTaxonomy } from '@/lib/taxonomy/trees'

import { createTestDb, type TestDb } from '../helpers/db'

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

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  return ((result as { rows?: T[] }).rows ?? []) as T[]
}

async function makeUser(email = 'student@example.com') {
  const [user] = await db.insert(users).values({ email }).returning({ id: users.id })
  return user.id
}

describe('migration', () => {
  it('creates every table the app uses', async () => {
    const result = await db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    )
    const names = new Set(
      rows<{ table_name: string }>(result).map((row) => row.table_name),
    )

    for (const table of [
      'users',
      'accounts',
      'sessions',
      'verification_tokens',
      'user_ai_credentials',
      'worksheets',
      'worksheet_pages',
      'questions',
      'answer_choices',
      'topics',
      'question_topics',
      'topic_proposals',
      'attempts',
      'explanations',
      'review_cards',
      'review_logs',
      'processing_jobs',
      'gpu_workers',
      'usage_events',
    ]) {
      expect(names.has(table), `missing table: ${table}`).toBe(true)
    }
  })

  it('enables pgvector with the dimensions the spec settled on', async () => {
    const result = await db.execute(
      sql`select atttypmod from pg_attribute
          where attrelid = 'topics'::regclass and attname = 'embedding'`,
    )
    expect(rows<{ atttypmod: number }>(result)[0]?.atttypmod).toBe(384)
  })
})

describe('taxonomy seeding', () => {
  it('inserts the full tree with working parent links', async () => {
    const flat = [...flattenTaxonomy()].sort((a, b) => a.depth - b.depth)
    const idBySlug = new Map<string, string>()

    for (const node of flat) {
      const [row] = await db
        .insert(topics)
        .values({
          slug: node.slug,
          name: node.name,
          parentId: node.parentSlug ? idBySlug.get(node.parentSlug)! : null,
          depth: node.depth,
          subjectRoot: node.subjectRoot,
          isLeaf: node.isLeaf,
        })
        .returning({ id: topics.id })
      idBySlug.set(node.slug, row.id)
    }

    const leaves = await db.select().from(topics).where(eq(topics.isLeaf, true))
    expect(leaves.length).toBe(flat.filter((node) => node.isLeaf).length)

    const child = await db
      .select()
      .from(topics)
      .where(eq(topics.slug, 'high-school-math.geometry.triangles.triangle-angle-sum'))
    expect(child[0]?.parentId).toBe(
      idBySlug.get('high-school-math.geometry.triangles'),
    )
  })
})

describe('attempts and review cards', () => {
  it('enforces one card per user per question', async () => {
    const userId = await makeUser('cards@example.com')

    const [worksheet] = await db
      .insert(worksheets)
      .values({ userId, title: 'Set A', sourceType: 'pdf_digital', pageCount: 1 })
      .returning({ id: worksheets.id })

    const [question] = await db
      .insert(questions)
      .values({
        userId,
        worksheetId: worksheet.id,
        ordinal: 1,
        promptText: 'What is the measure of angle C?',
        questionType: 'multiple_choice',
      })
      .returning({ id: questions.id })

    const first = scheduleFromOutcome(null, 'wrong').card
    await db.insert(reviewCards).values({ userId, questionId: question.id, ...first })

    const second = scheduleFromOutcome(first, 'correct').card
    await db
      .insert(reviewCards)
      .values({ userId, questionId: question.id, ...second })
      .onConflictDoUpdate({
        target: [reviewCards.userId, reviewCards.questionId],
        set: second,
      })

    const cards = await db
      .select()
      .from(reviewCards)
      .where(eq(reviewCards.questionId, question.id))

    expect(cards).toHaveLength(1)
    expect(cards[0].reps).toBe(2)
  })

  it('cascades attempts away when a question is deleted', async () => {
    const userId = await makeUser('cascade@example.com')

    const [worksheet] = await db
      .insert(worksheets)
      .values({ userId, title: 'Set B', sourceType: 'photo', pageCount: 1 })
      .returning({ id: worksheets.id })

    const [question] = await db
      .insert(questions)
      .values({
        userId,
        worksheetId: worksheet.id,
        ordinal: 1,
        promptText: 'Solve for x.',
        questionType: 'free_response',
      })
      .returning({ id: questions.id })

    await db.insert(attempts).values({
      userId,
      questionId: question.id,
      outcome: 'wrong',
      source: 'markup',
    })

    await db.delete(questions).where(eq(questions.id, question.id))

    const remaining = await db
      .select()
      .from(attempts)
      .where(eq(attempts.questionId, question.id))

    expect(remaining).toHaveLength(0)
  })
})
