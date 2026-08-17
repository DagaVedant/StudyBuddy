import { normalizeForCompare, normalizeOptionText } from '@/lib/questions/shape'

export type ValidationCode =
  | 'empty_stem'
  | 'no_choices'
  | 'too_few_choices'
  | 'duplicate_choices'
  | 'duplicate_labels'
  | 'choice_text_in_stem'
  | 'stem_looks_truncated'
  | 'stem_reads_like_passage'
  | 'stem_is_not_a_question'
  | 'stem_is_only_options'

export interface ValidationFlag {
  code: ValidationCode
  detail: string
  severity: 'high' | 'low'
}

export interface ValidatableQuestion {
  printedNumber: number | null
  promptText: string
  questionType: string
  choices: { label: string; text: string }[]
}

const CHOICE_BEARING = new Set(['multiple_choice', 'true_false'])

export function modalChoiceCount(questions: ValidatableQuestion[]): number | null {
  const counts = new Map<number, number>()

  for (const question of questions) {
    if (!CHOICE_BEARING.has(question.questionType)) continue
    const n = question.choices.length
    if (n === 0) continue
    counts.set(n, (counts.get(n) ?? 0) + 1)
  }

  let best: number | null = null
  let bestSeen = 0
  let tied = false

  for (const [n, seen] of counts) {
    if (seen > bestSeen) {
      best = n
      bestSeen = seen
      tied = false
    } else if (seen === bestSeen) {
      tied = true
    }
  }

  if (tied || bestSeen < 3) return null
  return best
}

const CUT_OFF = /[,;\-–—(\[]\s*$/

const PROSE = /[a-z]{3,}/g

const MATHS = /[=<>+−×÷≤≥]|\d+\s*[-*/]\s*\d+/
const HAS_QUESTION_SHAPE = /[?:]/

const ASKS = /\?/

const OPTION_MARK = /(?<![\p{L}\p{N}])\(?([A-Za-z])[).][ \t]+/gu

const MAX_OPTION_TEXT = 300

export function isOptionRun(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false

  const marks: { label: string; at: number; textFrom: number }[] = []
  OPTION_MARK.lastIndex = 0

  for (let match = OPTION_MARK.exec(trimmed); match; match = OPTION_MARK.exec(trimmed)) {
    marks.push({
      label: match[1].toUpperCase(),
      at: match.index,
      textFrom: match.index + match[0].length,
    })
  }

  if (marks.length < 3) return false

  if (trimmed.slice(0, marks[0].at).trim().length > 0) return false

  const first = marks[0].label.charCodeAt(0)
  if (first < 'A'.charCodeAt(0) || first > 'E'.charCodeAt(0)) return false
  if (!marks.every((mark, index) => mark.label.charCodeAt(0) === first + index)) return false

  return marks.every((mark, index) => {
    const body = trimmed.slice(mark.textFrom, marks[index + 1]?.at ?? trimmed.length).trim()
    return body.length > 0 && body.length <= MAX_OPTION_TEXT
  })
}

export function validateQuestion(
  question: ValidatableQuestion,
  options: { expectedChoiceCount?: number | null } = {},
): ValidationFlag[] {
  const flags: ValidationFlag[] = []
  const stem = question.promptText.trim()
  const normalizedStem = normalizeForCompare(stem)

  if (normalizedStem.length < 10) {
    flags.push({
      code: 'empty_stem',
      detail: `stem is ${normalizedStem.length} characters`,
      severity: 'high',
    })
  }

  const wantsChoices = CHOICE_BEARING.has(question.questionType)

  if (wantsChoices && question.choices.length === 0) {
    flags.push({
      code: 'no_choices',
      detail: 'multiple choice with no options',
      severity: 'high',
    })
  }

  const expected = options.expectedChoiceCount ?? null
  if (
    wantsChoices &&
    expected !== null &&
    question.choices.length > 0 &&
    question.choices.length < expected
  ) {
    flags.push({
      code: 'too_few_choices',
      detail: `${question.choices.length} options where this paper uses ${expected}`,
      severity: 'high',
    })
  }

  const seenText = new Set<string>()
  const seenLabel = new Set<string>()

  for (const choice of question.choices) {
    const text = normalizeOptionText(choice.text)
    const label = normalizeForCompare(choice.label)
    const prose = normalizeForCompare(choice.text)

    if (text.length > 0) {
      if (seenText.has(text)) {
        flags.push({
          code: 'duplicate_choices',
          detail: `two options read "${choice.text.slice(0, 40)}"`,
          severity: 'high',
        })
      }
      seenText.add(text)
    }

    if (label.length > 0) {
      if (seenLabel.has(label)) {
        flags.push({
          code: 'duplicate_labels',
          detail: `label ${choice.label} appears twice`,
          severity: 'high',
        })
      }
      seenLabel.add(label)
    }

    if (prose.length >= 12 && normalizedStem.includes(prose)) {
      flags.push({
        code: 'choice_text_in_stem',
        detail: `option ${choice.label} also appears in the stem`,
        severity: 'low',
      })
    }
  }

  const openQuotes = (stem.match(/[“]/g) ?? []).length
  const closeQuotes = (stem.match(/[”]/g) ?? []).length

  if (normalizedStem.length >= 25 && (CUT_OFF.test(stem) || openQuotes > closeQuotes)) {
    flags.push({
      code: 'stem_looks_truncated',
      detail: `stem ends "${stem.slice(-24)}"`,
      severity: 'low',
    })
  }

  if (!ASKS.test(stem) && (stem.match(PROSE) ?? []).length < 3 && !MATHS.test(stem)) {
    flags.push({
      code: 'stem_is_not_a_question',
      detail: `nothing asked: "${stem.slice(0, 40)}"`,
      severity: 'high',
    })
  }

  if (isOptionRun(stem)) {
    flags.push({
      code: 'stem_is_only_options',
      detail: `options with no question: "${stem.slice(0, 40)}"`,
      severity: 'high',
    })
  }

  if (normalizedStem.length > 600 && !HAS_QUESTION_SHAPE.test(stem)) {
    flags.push({
      code: 'stem_reads_like_passage',
      detail: `${normalizedStem.length} characters with no question mark`,
      severity: 'low',
    })
  }

  return flags
}

export function worthRereading(flags: ValidationFlag[]): boolean {
  if (flags.some((f) => f.severity === 'high')) return true
  return flags.filter((f) => f.severity === 'low').length >= 2
}
