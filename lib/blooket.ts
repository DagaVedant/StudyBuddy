import {NextResponse} from 'next/server'
import {and, asc, eq, inArray, sql} from 'drizzle-orm'

import {CHOICE_ORDER} from '@/lib/questions/queries'
import {answerChoices, attempts, questions, worksheets} from '@/lib/schema'
import {reflowText} from '@/lib/questions/shape'
import {type Db} from '@/lib/db'

const MAX_ANSWERS = 4
const WIDTH = 10
const TIME_LIMIT = 30

const BANNER = ['StudyBuddy: questions you missed']

const HEADERS = [
  'Question #', 'Question Text', 'Answer 1', 'Answer 2', 'Answer 3 (Optional)',
  'Answer 4 (Optional)', 'Time Limit (sec)', 'Correct Answer(s)',
]

export type ExportChoice = {
  label: string
  text: string
  isCorrect: boolean
}

export type ExportQuestion = {
  id: string
  promptText: string
  questionType: string
  correctAnswer: string | null
  choices: ExportChoice[]
}

type ShapedChoice = {
  label: string
  text: string
  isCorrect: boolean
  correct: boolean
}

type Row = {
  skip: string
  prompt: string
  answers: string[]
  correct: number[]
  typed: boolean
}

function exportFilename(on: string, title?: string) {
  let slug = ''

  if (title) {
    slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 60)
      .replace(/^-+|-+$/g, '')
  }

  if (slug) return 'studybuddy-missed-' + slug + '-' + on + '.csv'
  return 'studybuddy-missed-' + on + '.csv'
}

function quote(value: string) {
  if (!/[",\r\n]/.test(value)) return value
  return '"' + value.replace(/"/g, '""') + '"'
}

function line(fields: string[]) {
  let padded = fields.slice(0, WIDTH)
  while (padded.length < WIDTH) padded.push('')

  let out = []
  for (let field of padded) out.push(quote(field))

  return out.join(',')
}

function cell(text: string) {
  return reflowText(text).replace(/\s+/g, ' ').trim()
}

function labelKey(value: string) {
  return value.trim().replace(/[.):]+$/, '').toLowerCase()
}

function markCorrect(choices: ShapedChoice[], correctAnswer: string | null) {
  let found = false

  for (let choice of choices) {
    if (choice.isCorrect) {
      choice.correct = true
      found = true
    }
  }

  if (found) return

  let key = labelKey(correctAnswer || '')
  if (!key) return

  for (let choice of choices) {
    if (labelKey(choice.label) === key) {
      choice.correct = true
      found = true
    }
  }

  if (found) return

  for (let choice of choices) {
    if (choice.text.toLowerCase() === key) choice.correct = true
  }
}

function trimToFour(choices: ShapedChoice[]) {
  if (choices.length <= MAX_ANSWERS) return choices

  let correct = []
  for (let choice of choices) {
    if (choice.correct) correct.push(choice)
  }

  if (correct.length >= MAX_ANSWERS) return correct.slice(0, MAX_ANSWERS)

  let kept = []
  for (let choice of correct) kept.push(choice)

  let room = MAX_ANSWERS - correct.length
  for (let choice of choices) {
    if (choice.correct) continue
    if (room === 0) break

    kept.push(choice)
    room = room - 1
  }

  let out = []
  for (let choice of choices) {
    if (kept.indexOf(choice) >= 0) out.push(choice)
  }

  return out
}

function skipRow(reason: string): Row {
  return {skip: reason, prompt: '', answers: [], correct: [], typed: false}
}

function shape(question: ExportQuestion): Row {
  let prompt = cell(question.promptText)
  if (!prompt) return skipRow('no-prompt')

  let choices: ShapedChoice[] = []

  for (let choice of question.choices) {
    let text = cell(choice.text)
    if (!text) continue

    choices.push({
      label: choice.label,
      text: text,
      isCorrect: choice.isCorrect,
      correct: false,
    })
  }

  markCorrect(choices, question.correctAnswer)

  let markedCount = 0
  for (let choice of choices) {
    if (choice.correct) markedCount = markedCount + 1
  }

  if (choices.length >= 2 && markedCount > 0) {
    let kept = trimToFour(choices)

    let answers = []
    let correct = []

    for (let i = 0; i < kept.length; i++) {
      answers.push(kept[i].text)
      if (kept[i].correct) correct.push(i + 1)
    }

    return {skip: '', prompt: prompt, answers: answers, correct: correct, typed: false}
  }

  let answer = cell(question.correctAnswer || '')
  if (!answer) return skipRow('no-answer')

  if (question.questionType === 'true_false') {
    let truth = 0
    if (/^(true|t)$/i.test(answer)) truth = 1
    if (/^(false|f)$/i.test(answer)) truth = 2

    if (truth > 0) {
      return {
        skip: '',
        prompt: prompt,
        answers: ['True', 'False'],
        correct: [truth],
        typed: false,
      }
    }
  }

  return {skip: '', prompt: prompt, answers: [answer], correct: [1], typed: true}
}

function toBlooketCsv(list: ExportQuestion[]) {
  let skipped = []
  let lines = [line(BANNER), line(HEADERS)]
  let included = 0

  for (let question of list) {
    let row = shape(question)

    if (row.skip) {
      skipped.push({questionId: question.id, reason: row.skip})
      continue
    }

    included = included + 1

    let answers = []
    for (let answer of row.answers) answers.push(answer)
    while (answers.length < MAX_ANSWERS) answers.push('')

    let typed = ''
    if (row.typed) typed = 'typing'

    let fields = [String(included), row.prompt]
    for (let answer of answers) fields.push(answer)
    fields.push(String(TIME_LIMIT))
    fields.push(row.correct.join(','))
    fields.push('')
    fields.push(typed)

    lines.push(line(fields))
  }

  return {csv: '\ufeff' + lines.join('\r\n') + '\r\n', included: included, skipped: skipped}
}

export function blooketDownload(missed: ExportQuestion[], title?: string) {
  let result = toBlooketCsv(missed)

  if (result.included === 0) {
    let body = 'Nothing to export yet.'

    if (result.skipped.length > 0) {
      body =
        'None of the questions you missed have an answer key, so there is nothing Blooket could score.'
    }

    return new NextResponse(body, {status: 404})
  }

  let on = new Date().toISOString().slice(0, 10)
  let filename = exportFilename(on, title)

  return new NextResponse(result.csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + filename + '"',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Export-Included': String(result.included),
      'X-Export-Skipped': String(result.skipped.length),
    },
  })
}

export const EXPORT_LIMIT = 1000

function everMissed(userId: string) {
  return sql`exists (
    select 1 from ${attempts}
    where ${attempts.questionId} = ${questions.id}
      and ${attempts.userId} = ${userId}
      and ${attempts.outcome} in ('wrong', 'unsure')
  )`
}

function missedBy(userId: string, worksheetId?: string) {
  let sameWorksheet = undefined
  if (worksheetId) sameWorksheet = eq(questions.worksheetId, worksheetId)

  return and(
    eq(questions.userId, userId),
    eq(questions.origin, 'extracted'),
    sameWorksheet,
    everMissed(userId),
  )
}

export type MissedFilter = {
  worksheetId?: string
  limit?: number
}

export async function getMissedQuestions(db: Db, userId: string, filter: MissedFilter = {}) {
  let worksheetId = filter.worksheetId

  let limit = EXPORT_LIMIT
  if (filter.limit !== undefined) limit = filter.limit

  const rows = await db
    .select({
      id: questions.id,
      promptText: questions.promptText,
      questionType: questions.questionType,
      correctAnswer: questions.correctAnswer,
    })
    .from(questions)
    .innerJoin(worksheets, eq(worksheets.id, questions.worksheetId))
    .where(missedBy(userId, worksheetId))
    .orderBy(asc(worksheets.createdAt), asc(questions.ordinal))
    .limit(limit)

  if (rows.length === 0) return []

  let ids = []
  for (let row of rows) ids.push(row.id)

  const choices = await db
    .select({
      questionId: answerChoices.questionId,
      label: answerChoices.label,
      text: answerChoices.text,
      isCorrect: answerChoices.isCorrect,
    })
    .from(answerChoices)
    .where(inArray(answerChoices.questionId, ids))
    .orderBy(...CHOICE_ORDER)

  let choicesFor = new Map<string, ExportChoice[]>()

  for (let choice of choices) {
    let entry = {label: choice.label, text: choice.text, isCorrect: choice.isCorrect}
    let list = choicesFor.get(choice.questionId)

    if (list) {
      list.push(entry)
    } else {
      choicesFor.set(choice.questionId, [entry])
    }
  }

  let out: ExportQuestion[] = []

  for (let row of rows) {
    let list = choicesFor.get(row.id)
    if (!list) list = []

    out.push({
      id: row.id,
      promptText: row.promptText,
      questionType: row.questionType,
      correctAnswer: row.correctAnswer,
      choices: list,
    })
  }

  return out
}

export async function countExportableQuestions(db: Db, userId: string, worksheetId?: string) {
  const [row] = await db
    .select({value: sql<number>`count(*)::int`})
    .from(questions)
    .where(
      and(
        missedBy(userId, worksheetId),
        sql`(
          coalesce(btrim(${questions.correctAnswer}), '') <> ''
          or (
            (
              select count(*) from ${answerChoices} c
              where c.question_id = ${questions.id} and coalesce(btrim(c.text), '') <> ''
            ) >= 2
            and exists (
              select 1 from ${answerChoices} c
              where c.question_id = ${questions.id} and c.is_correct
            )
          )
        )`,
      ),
    )

  return Number(row.value)
}
