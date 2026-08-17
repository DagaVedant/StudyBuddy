import { reflowText } from '@/lib/questions/reflow'

const MAX_ANSWERS = 4

const WIDTH = 10

const TIME_LIMIT = 30

const BANNER = ['StudyBuddy: questions you missed']

const HEADERS = [
  'Question #',
  'Question Text',
  'Answer 1',
  'Answer 2',
  'Answer 3 (Optional)',
  'Answer 4 (Optional)',
  'Time Limit (sec)',
  'Correct Answer(s)',
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
  skipped: { questionId: string; reason: SkipReason }[]
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
    .map((choice) => ({ ...choice, text: cell(choice.text) }))
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
      return { prompt, answers: ['True', 'False'], correct: [truth], typed: false }
    }
  }

  return { prompt, answers: [answer], correct: [1], typed: true }
}

export function toBlooketCsv(questions: ExportQuestion[]): BlooketCsv {
  const skipped: BlooketCsv['skipped'] = []
  const lines = [line(BANNER), line(HEADERS)]

  let included = 0

  for (const question of questions) {
    const row = shape(question)

    if (typeof row === 'string') {
      skipped.push({ questionId: question.id, reason: row })
      continue
    }

    included += 1

    const answers = [...row.answers]
    while (answers.length < MAX_ANSWERS) answers.push('')

    lines.push(
      line([
        String(included),
        row.prompt,
        ...answers,
        String(TIME_LIMIT),
        row.correct.join(','),
        '',
        row.typed ? 'typing' : '',
      ]),
    )
  }

  return { csv: `﻿${lines.join('\r\n')}\r\n`, included, skipped }
}
