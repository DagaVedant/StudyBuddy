import {and, asc, desc, eq, isNotNull, isNull, sql} from 'drizzle-orm'

import {
  answerChoices,
  attempts,
  questions,
  questionSolutions,
  questionTopics,
  reviewCards,
  topicLessons,
  topics,
  usageEvents,
  worksheets,
} from '@/lib/db/schema'
import {
  hashQuestion,
  normalizeForCompare,
  normalizeOptionText,
} from '@/lib/questions/shape'
import {
  type AIProvider,
  type GeneratedQuestion,
  type Lesson,
  type LessonInput,
  type PracticeInput,
  type ProviderName,
} from '@/lib/ai/types'
import {pathBySlug} from '@/lib/taxonomy'
import {storedProvider, type Tier} from '@/lib/ai/resolve'
import {type Db} from '@/lib/db'
import {validateQuestion, type ValidationFlag} from '@/lib/questions/validate'

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
  rejected: {flags: PracticeFlag[]}[]
  questionIds: string[]
}

async function findPracticeWorksheet(db: Db, userId: string): Promise<string | null> {
  const [existing] = await db
    .select({id: worksheets.id})
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
      .returning({id: worksheets.id})

    return created.id
  } catch (error) {
    const raced = await findPracticeWorksheet(db, userId)
    if (raced) return raced

    throw error
  }
}

async function ownedStems(db: Db, userId: string, topicId: string): Promise<string[]> {
  const rows = await db
    .select({promptText: questions.promptText})
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
    .select({contentHash: questions.contentHash})
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
    .select({name: topics.name, slug: topics.slug})
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

  const {kept, rejected} = siftPractice(written.slice(0, count), hashes)

  if (kept.length === 0) {
    return {created: 0, rejected: rejected.map(({flags}) => ({flags})), questionIds: []}
  }

  const questionIds = await store(db, author, request, kept)

  return {
    created: questionIds.length,
    rejected: rejected.map(({flags}) => ({flags})),
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
    .select({ordinal: sql<number>`coalesce(max(${questions.ordinal}), 0)::int`})
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
        .returning({id: questions.id})

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
    .select({value: sql<number>`count(*)::int`})
    .from(questions)
    .where(and(eq(questions.userId, userId), eq(questions.origin, 'generated')))

  if (!topicId) {
    const [row] = await query
    return Number(row?.value ?? 0)
  }

  const [row] = await db
    .select({value: sql<number>`count(*)::int`})
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
    }).map((flag) => ({...flag})),
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
  rejected: {question: GeneratedQuestion; flags: PracticeFlag[]}[]
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
    const flags = validateGenerated(question, {seenStems, ownedHashes: owned})

    if (!isUsable(flags)) {
      rejected.push({question, flags})
      continue
    }

    seenStems.add(normalizeForCompare(question.prompt_text))
    owned.add(practiceHash(question))
    kept.push(question)
  }

  return {kept, rejected}
}
const SAMPLE_QUESTIONS = 5

export interface StoredLesson {
  bodyMd: string
  examples: {question: string; working: string; answer: string}[]
  commonErrors: {mistake: string; why: string; fix: string}[]
  model: string | null
  generatedAt: Date
}

function ownedBy(userId: string | null) {
  return userId === null
    ? isNull(topicLessons.userId)
    : eq(topicLessons.userId, userId)
}

async function lessonFor(
  db: Db,
  topicId: string,
  userId: string | null,
): Promise<StoredLesson | null> {
  const [row] = await db
    .select({
      bodyMd: topicLessons.bodyMd,
      examples: topicLessons.examples,
      commonErrors: topicLessons.commonErrors,
      model: topicLessons.model,
      generatedAt: topicLessons.generatedAt,
    })
    .from(topicLessons)
    .where(and(eq(topicLessons.topicId, topicId), ownedBy(userId)))
    .limit(1)

  if (!row) return null

  return {
    bodyMd: row.bodyMd,
    examples: row.examples ?? [],
    commonErrors: row.commonErrors ?? [],
    model: row.model,
    generatedAt: row.generatedAt,
  }
}

export async function getOwnLesson(
  db: Db,
  topicId: string,
  userId: string,
): Promise<StoredLesson | null> {
  return lessonFor(db, topicId, userId)
}

export async function getLesson(
  db: Db,
  topicId: string,
  userId: string | null,
): Promise<StoredLesson | null> {
  const canonical = await lessonFor(db, topicId, null)
  if (canonical || userId === null) return canonical

  return lessonFor(db, topicId, userId)
}

export async function lessonInput(db: Db, topicId: string): Promise<LessonInput> {
  const [topic] = await db
    .select({name: topics.name, slug: topics.slug})
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1)

  if (!topic) throw new Error(`No topic ${topicId}`)

  return {
    topicName: topic.name,
    topicPath: pathBySlug().get(topic.slug) ?? topic.name,
    samples: await sampleQuestions(db, topicId),
  }
}

export async function storeLesson(
  db: Db,
  topicId: string,
  userId: string | null,
  lesson: Lesson,
  model: string | null,
): Promise<StoredLesson> {
  const values = {
    topicId,
    userId,
    bodyMd: trimLessonBody(lesson.body_md),
    examples: lesson.examples,
    commonErrors: lesson.common_errors,
    provider: null,
    model,
  }

  const conflict =
    userId === null
      ? {
          target: topicLessons.topicId,
          targetWhere: isNull(topicLessons.userId),
        }
      : {
          target: [topicLessons.topicId, topicLessons.userId],
          targetWhere: isNotNull(topicLessons.userId),
        }

  await db
    .insert(topicLessons)
    .values(values)
    .onConflictDoUpdate({...conflict, set: values})

  return {
    bodyMd: values.bodyMd,
    examples: lesson.examples,
    commonErrors: lesson.common_errors,
    model,
    generatedAt: new Date(),
  }
}

export async function generateLesson(
  db: Db,
  provider: AIProvider,
  topicId: string,
  options: {force?: boolean} = {},
): Promise<StoredLesson | null> {
  if (!options.force) {
    const existing = await getLesson(db, topicId, null)
    if (existing) return null
  }

  const lesson = await provider.teachTopic(await lessonInput(db, topicId))

  return storeLesson(db, topicId, null, lesson, provider.answeringModel)
}

async function sampleQuestions(db: Db, topicId: string): Promise<string[]> {
  const rows = await db
    .select({promptText: questions.promptText})
    .from(questions)
    .innerJoin(questionTopics, eq(questionTopics.questionId, questions.id))
    .where(and(eq(questionTopics.topicId, topicId), isNotNull(questions.promptText)))
    .orderBy(desc(sql`length(${questions.promptText})`))
    .limit(SAMPLE_QUESTIONS)

  return rows.map((row) => row.promptText)
}

export async function topicsNeedingLessons(
  db: Db,
  limit = 20,
  options: {includeWritten?: boolean} = {},
): Promise<{topicId: string; name: string; attempts: number}[]> {
  const rows = await db
    .select({
      topicId: topics.id,
      name: topics.name,
      attempts: sql<number>`count(*)::int`,
    })
    .from(questionTopics)
    .innerJoin(topics, eq(topics.id, questionTopics.topicId))
    .where(
      options.includeWritten
        ? sql`true`
        : sql`not exists (
            select 1 from ${topicLessons}
            where ${topicLessons.topicId} = ${topics.id}
              and ${topicLessons.userId} is null
          )`,
    )
    .groupBy(topics.id, topics.name)
    .orderBy(desc(sql`count(*)`), asc(topics.name))
    .limit(limit)

  return rows
}

const SECTION_START = /^(#{1,6})\s+(.*)$|^\*\*([^*]+)\*\*:?\s*$/

const DUPLICATED =
  /^(some\s+|a\s+few\s+|other\s+)?(worked\s+|sample\s+|practice\s+)?(examples?|common\s+(errors?|mistakes?|pitfalls?)|errors?|mistakes?|pitfalls?|traps?|things\s+to\s+(avoid|watch\s+(out\s+)?for)|watch\s+outs?|what\s+(people|students)\s+get\s+wrong)\b/i

interface Section {
  title: string
  level: number
}

function sectionOf(line: string): Section | null {
  const match = SECTION_START.exec(line.trim())
  if (!match) return null

  if (match[3] !== undefined) return {title: match[3].trim(), level: 99}

  return {title: (match[2] ?? '').trim(), level: match[1].length}
}

export function trimLessonBody(bodyMd: string): string {
  const lines = bodyMd.replace(/\r\n/g, '\n').split('\n')
  const kept: string[] = []

  let skipping = false

  for (const line of lines) {
    const section = sectionOf(line)

    if (section) {
      if (section.level === 1 && !DUPLICATED.test(section.title)) {
        skipping = false
        continue
      }

      skipping = DUPLICATED.test(section.title)
      if (skipping) continue
    }

    if (!skipping) kept.push(line)
  }

  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
