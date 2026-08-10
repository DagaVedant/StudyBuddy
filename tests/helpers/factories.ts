import {
  answerChoices,
  attempts,
  questionTopics,
  questions,
  topics,
  users,
  worksheets,
} from '@/lib/db/schema'
import { flattenTaxonomy } from '@/lib/taxonomy/trees'

import type { TestDb } from './db'

export async function seedTaxonomy(db: TestDb): Promise<Map<string, string>> {
  const flat = [...flattenTaxonomy()].sort((a, b) => a.depth - b.depth)
  const idBySlug = new Map<string, string>()

  for (const node of flat) {
    const [row] = await db
      .insert(topics)
      .values({
        slug: node.slug,
        name: node.name,
        parentId: node.parentSlug ? (idBySlug.get(node.parentSlug) ?? null) : null,
        depth: node.depth,
        subjectRoot: node.subjectRoot,
        isLeaf: node.isLeaf,
      })
      .returning({ id: topics.id })
    idBySlug.set(node.slug, row.id)
  }

  return idBySlug
}

export async function makeUser(
  db: TestDb,
  email = `user-${crypto.randomUUID()}@example.com`,
): Promise<string> {
  const [user] = await db.insert(users).values({ email }).returning({ id: users.id })
  return user.id
}

export async function makeWorksheet(
  db: TestDb,
  userId: string,
  title = 'Practice Set',
): Promise<string> {
  const [row] = await db
    .insert(worksheets)
    .values({ userId, title, sourceType: 'pdf_digital', pageCount: 1, status: 'ready' })
    .returning({ id: worksheets.id })
  return row.id
}

interface QuestionSpec {
  ordinal?: number
  promptText?: string
  topicId?: string | null
  choices?: { label: string; text: string; isCorrect?: boolean }[]
  contentHash?: string
  embedding?: number[]
}

export async function makeQuestion(
  db: TestDb,
  userId: string,
  worksheetId: string,
  spec: QuestionSpec = {},
): Promise<{ id: string; choiceIds: Record<string, string> }> {
  const [question] = await db
    .insert(questions)
    .values({
      userId,
      worksheetId,
      ordinal: spec.ordinal ?? 1,
      promptText: spec.promptText ?? 'Solve for x.',
      questionType: spec.choices?.length ? 'multiple_choice' : 'free_response',
      userVerified: true,
      ...(spec.contentHash ? { contentHash: spec.contentHash } : {}),
      ...(spec.embedding ? { embedding: spec.embedding } : {}),
    })
    .returning({ id: questions.id })

  const choiceIds: Record<string, string> = {}

  for (const choice of spec.choices ?? []) {
    const [row] = await db
      .insert(answerChoices)
      .values({
        questionId: question.id,
        label: choice.label,
        text: choice.text,
        isCorrect: choice.isCorrect ?? false,
      })
      .returning({ id: answerChoices.id })
    choiceIds[choice.label] = row.id
  }

  if (spec.topicId) {
    await db.insert(questionTopics).values({
      questionId: question.id,
      topicId: spec.topicId,
      assignedBy: 'user',
      isPrimary: true,
    })
  }

  return { id: question.id, choiceIds }
}

export async function makeAttempt(
  db: TestDb,
  userId: string,
  questionId: string,
  outcome: 'correct' | 'unsure' | 'wrong',
  options: {
    selectedChoiceId?: string
    createdAt?: Date
    /**
     * Defaults to `markup`, which a question may only have once: the partial
     * unique index `attempts_markup_once` enforces it. A test that wants a
     * question attempted more than once is describing review, and has to say
     * so, because that is the only way it happens in the product too.
     */
    source?: 'markup' | 'review'
  } = {},
): Promise<void> {
  await db.insert(attempts).values({
    userId,
    questionId,
    outcome,
    selectedChoiceId: options.selectedChoiceId ?? null,
    source: options.source ?? 'markup',
    ...(options.createdAt ? { createdAt: options.createdAt } : {}),
  })
}
