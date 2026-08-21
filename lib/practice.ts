import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'

import { hashQuestion, normalizeForCompare, normalizeOptionText } from '@/lib/questions/shape'
import { pathBySlug } from '@/lib/taxonomy'
import { type Db } from '@/lib/db/types'
import {
  type AIProvider,
  type GeneratedQuestion,
  type PracticeInput,
  type ProviderName,
} from '@/lib/ai/types'
import { type Tier, storedProvider } from '@/lib/ai/resolve'
import { type ValidationFlag, validateQuestion } from '@/lib/questions/validate'

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

export const PRACTICE_BATCH = 4

export const PRACTICE_BATCH_MAX = 8

export const PRACTICE_WORKSHEET_TITLE = 'Practice written for you'

const SAMPLES_SHOWN = 6

const OWNED_HASHES = 2000

export interface PracticeAuthor {
  name: ProviderName
  answeringModel: string
}

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

function batchSize(count: number | undefined): number {
  return Math.max(1, Math.min(count ?? PRACTICE_BATCH, PRACTICE_BATCH_MAX))
}

export async function practiceInput(
  db: Db,
  request: PracticeRequest,
): Promise<PracticeInput> {
  const [topic] = await db
    .select({ name: topics.name, slug: topics.slug })
    .from(topics)
    .where(eq(topics.id, request.topicId))
    .limit(1)

  if (!topic) throw new Error(`No topic ${request.topicId}`)

  return {
    topicName: topic.name,
    topicPath: pathBySlug().get(topic.slug) ?? topic.name,
    owned: await ownedStems(db, request.userId, request.topicId),
    count: batchSize(request.count),
  }
}

export async function acceptPractice(
  db: Db,
  author: PracticeAuthor,
  request: PracticeRequest,
  written: GeneratedQuestion[],
): Promise<PracticeOutcome> {
  const count = batchSize(request.count)
  const hashes = await ownedHashes(db, request.userId)

  const { kept, rejected } = siftPractice(written.slice(0, count), hashes)

  if (kept.length === 0) {
    return { created: 0, rejected: rejected.map(({ flags }) => ({ flags })), questionIds: [] }
  }

  const questionIds = await store(db, author, request, kept)

  return {
    created: questionIds.length,
    rejected: rejected.map(({ flags }) => ({ flags })),
    questionIds,
  }
}

export async function generatePractice(
  db: Db,
  provider: AIProvider,
  request: PracticeRequest,
): Promise<PracticeOutcome> {
  const written = await provider.writePractice(await practiceInput(db, request))

  return acceptPractice(db, provider, request, written)
}

async function store(
  db: Db,
  author: PracticeAuthor,
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
          provider: storedProvider(author.name),
          model: author.answeringModel,
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
      provider: storedProvider(author.name),
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

const REQUIRED_CHOICES = 4

const CHOICE_LABELS = ['A', 'B', 'C', 'D']

export type PracticeCode =
  | 'wrong_choice_count'
  | 'labels_not_abcd'
  | 'no_correct_option'
  | 'answer_not_unique'
  | 'answer_in_stem'
  | 'answer_gives_itself_away'
  | 'option_about_the_options'
  | 'needs_a_figure'
  | 'markup_leaked'
  | 'no_working'
  | 'working_names_the_label'
  | 'duplicate_of_batch'
  | 'duplicate_of_library'

export interface PracticeFlag {
  code: PracticeCode | ValidationFlag['code']
  detail: string
  severity: 'high' | 'low'
}

const LATEX = /\\[a-zA-Z]+|\$[^$\n]*[\\^_{][^$\n]*\$|\^\{|_\{|\\\(|\\\[/

const FIGURE =
  /\b(figure|diagram|graph|chart|table|picture|image|shown above|shown below|the grid)\b/i

const META_OPTION =
  /^\s*(all|none|both|neither)\s+(of\s+)?(the\s+)?(above|these|options|answers)|^\s*(both|either)\s+[A-D]\s+and\s+[A-D]\b/i

const GIVEAWAY_RATIO = 1.8

const GIVEAWAY_FLOOR = 24

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function longestWrong(texts: string[]): number {
  return texts.reduce((longest, text) => Math.max(longest, text.length), 0)
}

function answerIsInStem(promptText: string, answerText: string): boolean {
  const answer = normalizeForCompare(answerText)
  if (answer.length === 0) return false

  const stem = normalizeForCompare(promptText)
  const words = answer.split(' ')

  if (words.length > 1) return answer.length >= 4 && stem.includes(answer)

  return stem.split(' ').includes(answer)
}

function checkLabels(question: GeneratedQuestion): PracticeFlag[] {
  const flags: PracticeFlag[] = []

  if (question.choices.length !== REQUIRED_CHOICES) {
    flags.push({
      code: 'wrong_choice_count',
      detail: `${question.choices.length} options where four are required`,
      severity: 'high',
    })
    return flags
  }

  const labels = question.choices.map((choice) => choice.label.toUpperCase())

  if (labels.join('') !== CHOICE_LABELS.join('')) {
    flags.push({
      code: 'labels_not_abcd',
      detail: `labelled ${labels.join(', ')} rather than A, B, C, D`,
      severity: 'high',
    })
  }

  return flags
}

function checkAnswer(question: GeneratedQuestion): PracticeFlag[] {
  const flags: PracticeFlag[] = []
  const wanted = question.correct_label.toUpperCase()

  const correct = question.choices.filter(
    (choice) => choice.label.toUpperCase() === wanted,
  )

  if (correct.length !== 1) {
    flags.push({
      code: 'no_correct_option',
      detail:
        correct.length === 0
          ? `answer ${question.correct_label} is not one of the options`
          : `answer ${question.correct_label} matches ${correct.length} options`,
      severity: 'high',
    })

    return flags
  }

  const key = correct[0]
  const others = question.choices.filter((choice) => choice !== key)

  const sameAsKey = others.filter(
    (choice) => normalizeOptionText(choice.text) === normalizeOptionText(key.text),
  )

  if (sameAsKey.length > 0) {
    flags.push({
      code: 'answer_not_unique',
      detail: `option ${sameAsKey[0].label} says the same thing as the answer`,
      severity: 'high',
    })
  }

  if (answerIsInStem(question.prompt_text, key.text)) {
    flags.push({
      code: 'answer_in_stem',
      detail: `the answer "${key.text.slice(0, 40)}" is printed in the question`,
      severity: 'high',
    })
  }

  const answerLength = key.text.trim().length
  const longest = longestWrong(others.map((choice) => choice.text.trim()))

  if (
    others.length > 0 &&
    answerLength >= GIVEAWAY_FLOOR &&
    answerLength > longest * GIVEAWAY_RATIO
  ) {
    flags.push({
      code: 'answer_gives_itself_away',
      detail: `the answer runs ${answerLength} characters against ${longest} for the longest other option`,
      severity: 'high',
    })
  }

  return flags
}

function checkOptions(question: GeneratedQuestion): PracticeFlag[] {
  const flags: PracticeFlag[] = []

  for (const choice of question.choices) {
    if (META_OPTION.test(choice.text)) {
      flags.push({
        code: 'option_about_the_options',
        detail: `option ${choice.label} reads "${choice.text.slice(0, 30)}"`,
        severity: 'high',
      })
    }
  }

  return flags
}

function checkProse(question: GeneratedQuestion): PracticeFlag[] {
  const flags: PracticeFlag[] = []

  const everything = [
    question.prompt_text,
    question.working,
    ...question.choices.map((choice) => choice.text),
  ].join('\n')

  if (LATEX.test(everything)) {
    flags.push({
      code: 'markup_leaked',
      detail: `markup a student would read as nonsense: "${LATEX.exec(everything)?.[0] ?? ''}"`,
      severity: 'high',
    })
  }

  if (FIGURE.test(question.prompt_text)) {
    flags.push({
      code: 'needs_a_figure',
      detail: `refers to "${FIGURE.exec(question.prompt_text)?.[0] ?? ''}" and there is nothing to look at`,
      severity: 'high',
    })
  }

  if (normalizeForCompare(question.working).length < 20) {
    flags.push({
      code: 'no_working',
      detail: 'no working to show the student afterwards',
      severity: 'high',
    })
  }

  const named = new RegExp(`\\boption ${escapeForRegExp(question.correct_label)}\\b`, 'i')

  if (question.correct_label.length > 0 && named.test(question.working)) {
    flags.push({
      code: 'working_names_the_label',
      detail: 'the working argues from the option letter rather than from the question',
      severity: 'low',
    })
  }

  return flags
}

export function practiceHash(question: GeneratedQuestion): string {
  return hashQuestion(question.prompt_text, question.choices)
}

export interface PracticeContext {
  seenStems?: Iterable<string>

  ownedHashes?: Iterable<string>
}

export function validateGenerated(
  question: GeneratedQuestion,
  context: PracticeContext = {},
): PracticeFlag[] {
  const flags: PracticeFlag[] = [
    ...validateQuestion({
      printedNumber: null,
      promptText: question.prompt_text,
      questionType: 'multiple_choice',
      choices: question.choices,
    }).map((flag) => ({ ...flag })),
    ...checkLabels(question),
    ...checkAnswer(question),
    ...checkOptions(question),
    ...checkProse(question),
  ]

  const stem = normalizeForCompare(question.prompt_text)
  const seen = new Set(context.seenStems ?? [])

  if (seen.has(stem)) {
    flags.push({
      code: 'duplicate_of_batch',
      detail: 'the same question twice in one batch',
      severity: 'high',
    })
  }

  const owned = new Set(context.ownedHashes ?? [])

  if (owned.has(practiceHash(question))) {
    flags.push({
      code: 'duplicate_of_library',
      detail: 'the student already has this exact question',
      severity: 'high',
    })
  }

  return flags
}

export function isUsable(flags: PracticeFlag[]): boolean {
  return !flags.some((flag) => flag.severity === 'high')
}

export interface SiftedPractice {
  kept: GeneratedQuestion[]
  rejected: { question: GeneratedQuestion; flags: PracticeFlag[] }[]
}

export function siftPractice(
  questions: GeneratedQuestion[],
  ownedHashes: Iterable<string> = [],
): SiftedPractice {
  const seenStems = new Set<string>()
  const owned = new Set(ownedHashes)

  const kept: GeneratedQuestion[] = []
  const rejected: SiftedPractice['rejected'] = []

  for (const question of questions) {
    const flags = validateGenerated(question, { seenStems, ownedHashes: owned })

    if (!isUsable(flags)) {
      rejected.push({ question, flags })
      continue
    }

    seenStems.add(normalizeForCompare(question.prompt_text))
    owned.add(practiceHash(question))
    kept.push(question)
  }

  return { kept, rejected }
}
