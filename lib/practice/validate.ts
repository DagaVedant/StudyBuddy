import type { GeneratedQuestion } from '@/lib/ai/types'
import { hashQuestion, normalizeForCompare, normalizeOptionText } from '@/lib/questions/shape'
import { validateQuestion, type ValidationFlag } from '@/lib/questions/validate'

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
