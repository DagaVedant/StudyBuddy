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

export interface ExportChoice {
  label: string
  text: string
  isCorrect: boolean
}

export interface ExportQuestion {
  id: string
  promptText: string
  questionType: string
  correctAnswer: string | null
  choices: ExportChoice[]
}

export type SkipReason = 'no-prompt' | 'no-answer'

export interface BlooketCsv {
  csv: string
  included: number
  skipped: {questionId: string; reason: SkipReason}[]
}

export function exportFilename(on: string, title?: string): string {
  const slug = (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '')

  return `studybuddy-missed-${slug ? `${slug}-` : ''}${on}.csv`
}

interface Row {
  prompt: string
  answers: string[]
  correct: number[]
  typed: boolean
}

function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function line(fields: string[]): string {
  const padded = [...fields.slice(0, WIDTH)]
  while (padded.length < WIDTH) padded.push('')
  return padded.map(quote).join(',')
}

function cell(text: string): string {
  return reflowText(text).replace(/\s+/g, ' ').trim()
}

function correctChoices(
  choices: ExportChoice[],
  correctAnswer: string | null,
): Set<ExportChoice> {
  const flagged = choices.filter((choice) => choice.isCorrect)
  if (flagged.length > 0) return new Set(flagged)

  const key = (correctAnswer ?? '').trim().replace(/[.):]+$/, '').toLowerCase()
  if (!key) return new Set()

  const byLabel = choices.filter(
    (choice) => choice.label.trim().replace(/[.):]+$/, '').toLowerCase() === key,
  )
  if (byLabel.length > 0) return new Set(byLabel)

  return new Set(choices.filter((choice) => choice.text.toLowerCase() === key))
}

function trimToFour(
  choices: ExportChoice[],
  marked: Set<ExportChoice>,
): ExportChoice[] {
  if (choices.length <= MAX_ANSWERS) return choices

  const correct = choices.filter((choice) => marked.has(choice))
  if (correct.length >= MAX_ANSWERS) return correct.slice(0, MAX_ANSWERS)

  const distractors = choices
    .filter((choice) => !marked.has(choice))
    .slice(0, MAX_ANSWERS - correct.length)

  const kept = new Set([...correct, ...distractors])
  return choices.filter((choice) => kept.has(choice))
}

function shape(question: ExportQuestion): Row | SkipReason {
  const prompt = cell(question.promptText)
  if (!prompt) return 'no-prompt'

  const choices = question.choices
    .map((choice) => ({...choice, text: cell(choice.text)}))
    .filter((choice) => choice.text)

  const marked = correctChoices(choices, question.correctAnswer)

  if (choices.length >= 2 && marked.size > 0) {
    const kept = trimToFour(choices, marked)
    return {
      prompt,
      answers: kept.map((choice) => choice.text),
      correct: kept.flatMap((choice, index) => (marked.has(choice) ? [index + 1] : [])),
      typed: false,
    }
  }

  const answer = cell(question.correctAnswer ?? '')
  if (!answer) return 'no-answer'

  if (question.questionType === 'true_false') {
    const truth = /^(true|t)$/i.test(answer) ? 1 : /^(false|f)$/i.test(answer) ? 2 : 0
    if (truth > 0) {
      return {prompt, answers: ['True', 'False'], correct: [truth], typed: false}
    }
  }

  return {prompt, answers: [answer], correct: [1], typed: true}
}

export function toBlooketCsv(questions: ExportQuestion[]): BlooketCsv {
  const skipped: BlooketCsv['skipped'] = []
  const lines = [line(BANNER), line(HEADERS)]

  let included = 0

  for (const question of questions) {
    const row = shape(question)

    if (typeof row === 'string') {
      skipped.push({questionId: question.id, reason: row})
      continue
    }

    included += 1

    const answers = [...row.answers]
    while (answers.length < MAX_ANSWERS) answers.push('')

    lines.push(
      line([
        String(included), row.prompt, ...answers, String(TIME_LIMIT), row.correct.join(','),
        '', row.typed ? 'typing' : '',
      ]),
    )
  }

  return {csv: `﻿${lines.join('\r\n')}\r\n`, included, skipped}
}

export function blooketDownload(
  missed: ExportQuestion[],
  title?: string,
): NextResponse {
  const {csv, included, skipped} = toBlooketCsv(missed)

  if (included === 0) {
    return new NextResponse(
      skipped.length > 0
        ? 'None of the questions you missed have an answer key, so there is nothing Blooket could score.'
        : 'Nothing to export yet.',
      {status: 404},
    )
  }

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${exportFilename(
        new Date().toISOString().slice(0, 10),
        title,
      )}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Export-Included': String(included),
      'X-Export-Skipped': String(skipped.length),
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
  return and(
    eq(questions.userId, userId),
    eq(questions.origin, 'extracted'),
    worksheetId ? eq(questions.worksheetId, worksheetId) : undefined,
    everMissed(userId),
  )
}

export interface MissedFilter {
  worksheetId?: string
  limit?: number
}

export async function getMissedQuestions(
  db: Db,
  userId: string,
  {worksheetId, limit = EXPORT_LIMIT}: MissedFilter = {},
): Promise<ExportQuestion[]> {
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

  const choices = await db
    .select({
      questionId: answerChoices.questionId,
      label: answerChoices.label,
      text: answerChoices.text,
      isCorrect: answerChoices.isCorrect,
    })
    .from(answerChoices)
    .where(
      inArray(
        answerChoices.questionId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(...CHOICE_ORDER)

  const choicesFor = new Map<string, ExportQuestion['choices']>()
  for (const choice of choices) {
    const list = choicesFor.get(choice.questionId)
    const entry = {label: choice.label, text: choice.text, isCorrect: choice.isCorrect}
    if (list) list.push(entry)
    else choicesFor.set(choice.questionId, [entry])
  }

  return rows.map((row) => ({
    id: row.id,
    promptText: row.promptText,
    questionType: row.questionType,
    correctAnswer: row.correctAnswer,
    choices: choicesFor.get(row.id) ?? [],
  }))
}

export async function countMissedQuestions(
  db: Db,
  userId: string,
  worksheetId?: string,
): Promise<number> {
  const [row] = await db
    .select({value: sql<number>`count(*)::int`})
    .from(questions)
    .where(missedBy(userId, worksheetId))

  return Number(row?.value ?? 0)
}
