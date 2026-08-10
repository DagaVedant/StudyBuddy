import { reflowText } from '@/lib/questions/reflow'

/**
 * Missed questions written out in Blooket's spreadsheet import format.
 *
 * Blooket hands out an .xlsx template but its uploader only accepts .csv: the
 * dropzone is `accept: ".csv"` and the instructions tell you to export before
 * uploading. So this produces CSV, not a workbook, even though the feature is
 * usually described as an Excel import.
 *
 * Three details of Blooket's parser drive most of what is below, and getting
 * any of them wrong imports zero questions with no error shown:
 *
 * 1. The first two lines are dropped unconditionally, by position. Blooket does
 *    not look for a header row by name, so the banner line and the header line
 *    exist to be discarded and to make the file readable if a person opens it.
 * 2. Every line must carry the same number of fields. The parser runs with
 *    `relax_column_count: false`, and when the comma parse throws it silently
 *    retries with a semicolon delimiter, at which point every line is one field
 *    and the whole import comes back empty. Hence {@link WIDTH}: every line is
 *    padded to ten fields, including the two that get thrown away.
 * 3. The correct answer is given as answer numbers, never letters and never the
 *    answer text. Several can be listed, comma separated, inside the cell.
 */

/** Blooket reads four answer columns and discards anything past them. */
const MAX_ANSWERS = 4

/** Columns A through J. Blooket truncates each row to ten fields. */
const WIDTH = 10

/** Seconds allowed per question. Blooket clamps this to the range 1 to 300. */
const TIME_LIMIT = 30

/** Discarded on import. Present so the file opens sensibly in a spreadsheet. */
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

/**
 * Why a question did not make it into the file.
 *
 * Both are reported rather than swallowed. A student who marked 40 questions
 * and gets a set of 31 is owed the difference, and the commonest cause by far
 * is `no-answer`: a paper marked up without an answer key records what was
 * missed but never what the right answer was, and Blooket cannot host a
 * question whose correct answer nobody knows.
 */
export type SkipReason = 'no-prompt' | 'no-answer'

export interface BlooketCsv {
  csv: string
  included: number
  skipped: { questionId: string; reason: SkipReason }[]
}

/**
 * What the browser saves the file as.
 *
 * The worksheet title is reduced to ASCII letters, digits and hyphens rather
 * than escaped. It lands inside a quoted `Content-Disposition` filename, and a
 * paper called `Unit 3 "Review"` would otherwise close that quoting early and
 * truncate the header. Reducing is safe by construction; escaping is safe only
 * if it is got exactly right, and there is nothing here worth spending that on.
 *
 * A title that survives as nothing, which is every title written in a script
 * with no ASCII in it, falls back to the undated name rather than to a stray
 * hyphen.
 */
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
  /** One-based answer numbers, which is the only form Blooket accepts. */
  correct: number[]
  /** Blooket's typed-answer mode, flagged by the literal string in column J. */
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

/**
 * One cell's worth of text.
 *
 * Stored prompts carry the hard breaks of the print column they were read
 * from, so they go through `reflowText` first to rejoin wrapped lines and
 * repair words the typesetter split across a hyphen. The breaks reflow keeps
 * on purpose, for list items, are then flattened too: a Blooket question is a
 * single line of text, and a newline inside a quoted cell survives the parser
 * only to be rendered as a space anyway.
 */
function cell(text: string): string {
  return reflowText(text).replace(/\s+/g, ' ').trim()
}

/**
 * The choices that are the right answer.
 *
 * Normally that is whatever `is_correct` marks. The fallback exists because a
 * key can arrive as `questions.correct_answer` instead, holding either the
 * label of a choice or a copy of its text, with no choice row flagged. Reading
 * only the flag turned those into `no-answer` skips for questions whose answer
 * we plainly had.
 */
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

/**
 * At most four choices, with every right answer kept.
 *
 * A five-option question is rare on paper but does happen, and Blooket has
 * nowhere to put the fifth. Dropping from the end would sometimes drop the
 * answer, so the correct ones are reserved first and distractors fill what is
 * left. The survivors are re-read in their original order so the question
 * still lists A before B.
 */
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

  // Two is Blooket's floor for a multiple choice question. A single surviving
  // choice is not a question you can play, so it falls through to the typed
  // path below and becomes a typed answer instead of importing as a one-option
  // question nobody can get wrong.
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

  // True or false questions do not always store their two options as rows, and
  // a typed answer is a bad way to ask one: Blooket matches typed answers
  // exactly, so "T" and "true" both count as wrong. Rebuilding the pair costs
  // nothing and gives back a question that can actually be played.
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
        // Column I carries no meaning; column J turns the row into a typed
        // answer when it holds this exact word.
        '',
        row.typed ? 'typing' : '',
      ]),
    )
  }

  // A byte order mark so Excel reads the file as UTF-8 rather than as the local
  // codepage. Worksheet prompts are full of ×, ÷ and ≤, and without it they
  // arrive mangled in the one place a student is most likely to look at them.
  // Blooket is unaffected: the mark sits in the banner line, which it discards.
  return { csv: `﻿${lines.join('\r\n')}\r\n`, included, skipped }
}
