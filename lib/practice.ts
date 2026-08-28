import {and, desc, eq, isNotNull, isNull, sql} from 'drizzle-orm'

import {answerChoices, attempts, questions, questionSolutions, questionTopics, reviewCards, topicLessons, topics, usageEvents, worksheets} from '@/lib/schema'
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
import {validateQuestion} from '@/lib/questions/numbering'

export const PRACTICE_BATCH = 4

export const PRACTICE_BATCH_MAX = 8

const PRACTICE_WORKSHEET_TITLE = 'Practice written for you'

const SAMPLES_SHOWN = 6

const OWNED_HASHES = 2000

export type PracticeAuthor = {
  name: ProviderName
  answeringModel: string
}

export type PracticeRequest = {
  userId: string
  topicId: string
  count?: number
  tier?: Tier
}

export type PracticeFlag = {
  code: string
  detail: string
  severity: 'high' | 'low'
}

export type PracticeOutcome = {
  created: number
  rejected: {flags: PracticeFlag[]}[]
  questionIds: string[]
}

async function findPracticeWorksheet(db: Db, userId: string) {
  const [existing] = await db
    .select({id: worksheets.id})
    .from(worksheets)
    .where(and(eq(worksheets.userId, userId), eq(worksheets.origin, 'generated')))
    .limit(1)

  if (!existing) return null
  return existing.id
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

async function ownedStems(db: Db, userId: string, topicId: string) {
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

  let stems = []
  for (let row of rows) stems.push(row.promptText)

  return stems
}

async function ownedHashes(db: Db, userId: string) {
  const rows = await db
    .select({contentHash: questions.contentHash})
    .from(questions)
    .where(and(eq(questions.userId, userId), isNotNull(questions.contentHash)))
    .orderBy(desc(questions.createdAt))
    .limit(OWNED_HASHES)

  let hashes: string[] = []
  for (let row of rows) {
    if (row.contentHash !== null) hashes.push(row.contentHash)
  }

  return hashes
}

function batchSize(count: number | undefined) {
  let wanted = PRACTICE_BATCH
  if (count !== undefined) wanted = count

  if (wanted < 1) wanted = 1
  if (wanted > PRACTICE_BATCH_MAX) wanted = PRACTICE_BATCH_MAX

  return wanted
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

  if (!topic) throw new Error('No topic ' + request.topicId)

  let topicPath = pathBySlug().get(topic.slug)
  if (!topicPath) topicPath = topic.name

  return {
    topicName: topic.name,
    topicPath: topicPath,
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

  const sifted = siftPractice(written.slice(0, count), hashes)

  let flagged = []
  for (let entry of sifted.rejected) flagged.push({flags: entry.flags})

  if (sifted.kept.length === 0) {
    return {created: 0, rejected: flagged, questionIds: []}
  }

  const questionIds = await store(db, author, request, sifted.kept)

  return {created: questionIds.length, rejected: flagged, questionIds}
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
) {
  const worksheetId = await practiceWorksheetId(db, request.userId)

  const [highest] = await db
    .select({ordinal: sql<number>`coalesce(max(${questions.ordinal}), 0)::int`})
    .from(questions)
    .where(eq(questions.worksheetId, worksheetId))

  const from = highest.ordinal
  const now = new Date()

  let tier = null
  if (request.tier) tier = request.tier

  return db.transaction(async (tx) => {
    const created: string[] = []

    for (let index = 0; index < written.length; index++) {
      const question = written[index]

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

      let choiceRows = []

      for (let choice of question.choices) {
        choiceRows.push({
          questionId: row.id,
          label: choice.label,
          text: choice.text,
          isCorrect: choice.label.toUpperCase() === question.correct_label.toUpperCase(),
        })
      }

      await tx.insert(answerChoices).values(choiceRows)

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
      tierUsed: tier,
      quantity: created.length,
    })

    return created
  })
}

export async function countGenerated(db: Db, userId: string, topicId: string) {
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

  return row.value
}

const REQUIRED_CHOICES = 4

const CHOICE_LABELS = ['A', 'B', 'C', 'D']

const LATEX = /\\[a-zA-Z]+|\$[^$\n]*[\\^_{][^$\n]*\$|\^\{|_\{|\\\(|\\\[/

const FIGURE =
  /\b(figure|diagram|graph|chart|table|picture|image|shown above|shown below|the grid)\b/i

const META_OPTION =
  /^\s*(all|none|both|neither)\s+(of\s+)?(the\s+)?(above|these|options|answers)|^\s*(both|either)\s+[A-D]\s+and\s+[A-D]\b/i

const GIVEAWAY_RATIO = 1.8

const GIVEAWAY_FLOOR = 24

function escapeForRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function answerIsInStem(promptText: string, answerText: string) {
  const answer = normalizeForCompare(answerText)
  if (answer.length === 0) return false

  const stem = normalizeForCompare(promptText)
  const words = answer.split(' ')

  if (words.length > 1) {
    if (answer.length < 4) return false
    return stem.includes(answer)
  }

  return stem.split(' ').includes(answer)
}

function checkLabels(question: GeneratedQuestion) {
  const flags: PracticeFlag[] = []

  if (question.choices.length !== REQUIRED_CHOICES) {
    flags.push({
      code: 'wrong_choice_count',
      detail: question.choices.length + ' options where four are required',
      severity: 'high',
    })

    return flags
  }

  let labels = []
  for (let choice of question.choices) labels.push(choice.label.toUpperCase())

  if (labels.join('') !== CHOICE_LABELS.join('')) {
    flags.push({
      code: 'labels_not_abcd',
      detail: 'labelled ' + labels.join(', ') + ' rather than A, B, C, D',
      severity: 'high',
    })
  }

  return flags
}

function checkAnswer(question: GeneratedQuestion) {
  const flags: PracticeFlag[] = []
  const wanted = question.correct_label.toUpperCase()

  let correct = []
  for (let choice of question.choices) {
    if (choice.label.toUpperCase() === wanted) correct.push(choice)
  }

  if (correct.length !== 1) {
    let detail = 'answer ' + question.correct_label + ' matches ' + correct.length + ' options'
    if (correct.length === 0) {
      detail = 'answer ' + question.correct_label + ' is not one of the options'
    }

    flags.push({code: 'no_correct_option', detail: detail, severity: 'high'})

    return flags
  }

  const key = correct[0]

  let others = []
  for (let choice of question.choices) {
    if (choice !== key) others.push(choice)
  }

  let sameAsKey = null
  for (let choice of others) {
    if (normalizeOptionText(choice.text) === normalizeOptionText(key.text)) {
      sameAsKey = choice
      break
    }
  }

  if (sameAsKey) {
    flags.push({
      code: 'answer_not_unique',
      detail: 'option ' + sameAsKey.label + ' says the same thing as the answer',
      severity: 'high',
    })
  }

  if (answerIsInStem(question.prompt_text, key.text)) {
    flags.push({
      code: 'answer_in_stem',
      detail: 'the answer "' + key.text.slice(0, 40) + '" is printed in the question',
      severity: 'high',
    })
  }

  const answerLength = key.text.trim().length

  let longest = 0
  for (let choice of others) {
    if (choice.text.trim().length > longest) longest = choice.text.trim().length
  }

  if (
    others.length > 0 &&
    answerLength >= GIVEAWAY_FLOOR &&
    answerLength > longest * GIVEAWAY_RATIO
  ) {
    flags.push({
      code: 'answer_gives_itself_away',
      detail:
        'the answer runs ' +
        answerLength +
        ' characters against ' +
        longest +
        ' for the longest other option',
      severity: 'high',
    })
  }

  return flags
}

function checkOptions(question: GeneratedQuestion) {
  const flags: PracticeFlag[] = []

  for (let choice of question.choices) {
    if (META_OPTION.test(choice.text)) {
      flags.push({
        code: 'option_about_the_options',
        detail: 'option ' + choice.label + ' reads "' + choice.text.slice(0, 30) + '"',
        severity: 'high',
      })
    }
  }

  return flags
}

function checkProse(question: GeneratedQuestion) {
  const flags: PracticeFlag[] = []

  let parts = [question.prompt_text, question.working]
  for (let choice of question.choices) parts.push(choice.text)

  const everything = parts.join('\n')

  const markup = LATEX.exec(everything)

  if (markup) {
    flags.push({
      code: 'markup_leaked',
      detail: 'markup a student would read as nonsense: "' + markup[0] + '"',
      severity: 'high',
    })
  }

  const figure = FIGURE.exec(question.prompt_text)

  if (figure) {
    flags.push({
      code: 'needs_a_figure',
      detail: 'refers to "' + figure[0] + '" and there is nothing to look at',
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

  const named = new RegExp(
    '\\boption ' + escapeForRegExp(question.correct_label) + '\\b',
    'i',
  )

  if (question.correct_label.length > 0 && named.test(question.working)) {
    flags.push({
      code: 'working_names_the_label',
      detail: 'the working argues from the option letter rather than from the question',
      severity: 'low',
    })
  }

  return flags
}

function practiceHash(question: GeneratedQuestion) {
  return hashQuestion(question.prompt_text, question.choices)
}

function validateGenerated(
  question: GeneratedQuestion,
  seenStems: Set<string>,
  owned: Set<string>,
) {
  const flags: PracticeFlag[] = []

  const basic = validateQuestion({
    printedNumber: null,
    promptText: question.prompt_text,
    questionType: 'multiple_choice',
    choices: question.choices,
  })

  for (let flag of basic) flags.push(flag)
  for (let flag of checkLabels(question)) flags.push(flag)
  for (let flag of checkAnswer(question)) flags.push(flag)
  for (let flag of checkOptions(question)) flags.push(flag)
  for (let flag of checkProse(question)) flags.push(flag)

  if (seenStems.has(normalizeForCompare(question.prompt_text))) {
    flags.push({
      code: 'duplicate_of_batch',
      detail: 'the same question twice in one batch',
      severity: 'high',
    })
  }

  if (owned.has(practiceHash(question))) {
    flags.push({
      code: 'duplicate_of_library',
      detail: 'the student already has this exact question',
      severity: 'high',
    })
  }

  return flags
}

function isUsable(flags: PracticeFlag[]) {
  for (let flag of flags) {
    if (flag.severity === 'high') return false
  }

  return true
}

function siftPractice(written: GeneratedQuestion[], hashes: string[]) {
  const seenStems = new Set<string>()
  const owned = new Set(hashes)

  const kept: GeneratedQuestion[] = []
  const rejected: {question: GeneratedQuestion; flags: PracticeFlag[]}[] = []

  for (let question of written) {
    const flags = validateGenerated(question, seenStems, owned)

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

export type StoredLesson = {
  bodyMd: string
  examples: {question: string; working: string; answer: string}[]
  commonErrors: {mistake: string; why: string; fix: string}[]
  model: string | null
  generatedAt: Date
}

async function lessonFor(db: Db, topicId: string, userId: string | null) {
  let ownedBy = isNull(topicLessons.userId)
  if (userId !== null) ownedBy = eq(topicLessons.userId, userId)

  const [row] = await db
    .select({
      bodyMd: topicLessons.bodyMd,
      examples: topicLessons.examples,
      commonErrors: topicLessons.commonErrors,
      model: topicLessons.model,
      generatedAt: topicLessons.generatedAt,
    })
    .from(topicLessons)
    .where(and(eq(topicLessons.topicId, topicId), ownedBy))
    .limit(1)

  if (!row) return null

  let examples = row.examples
  if (!examples) examples = []

  let commonErrors = row.commonErrors
  if (!commonErrors) commonErrors = []

  return {
    bodyMd: row.bodyMd,
    examples: examples,
    commonErrors: commonErrors,
    model: row.model,
    generatedAt: row.generatedAt,
  }
}

export async function getOwnLesson(db: Db, topicId: string, userId: string) {
  return lessonFor(db, topicId, userId)
}

export async function getLesson(db: Db, topicId: string, userId: string | null) {
  const canonical = await lessonFor(db, topicId, null)
  if (canonical) return canonical
  if (userId === null) return null

  return lessonFor(db, topicId, userId)
}

export async function lessonInput(db: Db, topicId: string): Promise<LessonInput> {
  const [topic] = await db
    .select({name: topics.name, slug: topics.slug})
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1)

  if (!topic) throw new Error('No topic ' + topicId)

  let topicPath = pathBySlug().get(topic.slug)
  if (!topicPath) topicPath = topic.name

  return {
    topicName: topic.name,
    topicPath: topicPath,
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

  if (userId === null) {
    await db
      .insert(topicLessons)
      .values(values)
      .onConflictDoUpdate({
        target: topicLessons.topicId,
        targetWhere: isNull(topicLessons.userId),
        set: values,
      })
  } else {
    await db
      .insert(topicLessons)
      .values(values)
      .onConflictDoUpdate({
        target: [topicLessons.topicId, topicLessons.userId],
        targetWhere: isNotNull(topicLessons.userId),
        set: values,
      })
  }

  return {
    bodyMd: values.bodyMd,
    examples: lesson.examples,
    commonErrors: lesson.common_errors,
    model,
    generatedAt: new Date(),
  }
}

export async function generateLesson(db: Db, provider: AIProvider, topicId: string) {
  const existing = await getLesson(db, topicId, null)
  if (existing) return null

  const lesson = await provider.teachTopic(await lessonInput(db, topicId))

  return storeLesson(db, topicId, null, lesson, provider.answeringModel)
}

async function sampleQuestions(db: Db, topicId: string) {
  const rows = await db
    .select({promptText: questions.promptText})
    .from(questions)
    .innerJoin(questionTopics, eq(questionTopics.questionId, questions.id))
    .where(and(eq(questionTopics.topicId, topicId), isNotNull(questions.promptText)))
    .orderBy(desc(sql`length(${questions.promptText})`))
    .limit(SAMPLE_QUESTIONS)

  let prompts = []
  for (let row of rows) prompts.push(row.promptText)

  return prompts
}

const SECTION_START = /^(#{1,6})\s+(.*)$|^\*\*([^*]+)\*\*:?\s*$/

const DUPLICATED =
  /^(some\s+|a\s+few\s+|other\s+)?(worked\s+|sample\s+|practice\s+)?(examples?|common\s+(errors?|mistakes?|pitfalls?)|errors?|mistakes?|pitfalls?|traps?|things\s+to\s+(avoid|watch\s+(out\s+)?for)|watch\s+outs?|what\s+(people|students)\s+get\s+wrong)\b/i

function sectionOf(line: string) {
  const match = SECTION_START.exec(line.trim())
  if (!match) return null

  if (match[3] !== undefined) return {title: match[3].trim(), level: 99}

  let title = ''
  if (match[2] !== undefined) title = match[2].trim()

  return {title: title, level: match[1].length}
}

function trimLessonBody(bodyMd: string) {
  const lines = bodyMd.replace(/\r\n/g, '\n').split('\n')
  const kept: string[] = []

  let skipping = false

  for (let line of lines) {
    const section = sectionOf(line)

    if (section) {
      const duplicated = DUPLICATED.test(section.title)

      if (section.level === 1 && !duplicated) {
        skipping = false
        continue
      }

      skipping = duplicated
      if (skipping) continue
    }

    if (!skipping) kept.push(line)
  }

  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
