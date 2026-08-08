import { normalizeForCompare } from '@/lib/questions/shape'

/**
 * Checks that need no model.
 *
 * The audit already catches a page that produced nothing, because a gap in the
 * printed numbering is visible from the numbers alone. What it cannot see is a
 * question that arrived looking fine and is wrong inside: a stem that stops
 * mid-sentence, choices that belong to the question above, two options where
 * the paper has four. Benchmarking put that at roughly one row in ten even for
 * the model that scored best on coverage, so it is not a rare case.
 */
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

export interface ValidationFlag {
  code: ValidationCode
  detail: string
  /**
   * high: the row is broken on its face; a re-read can only improve it.
   * low:  reads oddly, but plenty of real questions do. Worth a look, not
   *       worth acting on alone.
   */
  severity: 'high' | 'low'
}

export interface ValidatableQuestion {
  printedNumber: number | null
  promptText: string
  questionType: string
  choices: { label: string; text: string }[]
}

/** Question types where missing choices mean something was lost. */
const CHOICE_BEARING = new Set(['multiple_choice', 'true_false'])

/**
 * The most common choice count on the worksheet.
 *
 * A paper is internally consistent: every multiple-choice question on it
 * tends to offer the same number of options, so the sheet can say what
 * "complete" means instead of it being hardcoded. Returns null when there is
 * no clear winner, in which case the count is simply not checked.
 */
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

  // Two counts equally common says nothing about which is right.
  if (tied || bestSeen < 3) return null
  return best
}

/**
 * Marks that a stem was cut off rather than merely left open.
 *
 * Deliberately not "ends without punctuation": on this kind of paper a great
 * many stems are sentence openers finished by the options ("...affect the
 * tone of the excerpt by") and treating those as damaged flagged a fifth of a
 * clean extraction. A trailing comma or dash is a cut; a trailing preposition
 * is the question working as designed.
 */
const CUT_OFF = /[,;\-–—(\[]\s*$/

/** Three or more ordinary words is enough to call something a sentence. */
const PROSE = /[a-z]{3,}/g

/**
 * Any sign a calculation is being asked for.
 *
 * Needed because a real question can be almost wordless: "3.6 / 0.018 =" and
 * "3(0.01) - 3(0.1) =" are genuine items on these papers. A first version of
 * this check looked only for prose and would have condemned every one of them.
 */
const MATHS = /[=<>+−×÷≤≥]|\d+\s*[-*/]\s*\d+/
const HAS_QUESTION_SHAPE = /[?:]/

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
    const text = normalizeForCompare(choice.text)
    const label = normalizeForCompare(choice.label)

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

    // A choice repeated inside the stem is the signature of the extractor
    // swallowing the options into the question text and then listing them
    // again, the shape the page-3 split produced.
    if (text.length >= 12 && normalizedStem.includes(text)) {
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

  // Figure labels, page furniture and stray option letters get captured as
  // questions: "C(3,y)nA(5,7) B(11,7)" off a diagram, "CONTINUE ON TO THE NEXT
  // PAGE", a lone "(C)". None of them ask anything, and none of them contain
  // either a sentence or a calculation. Measured across 714 stored questions
  // this flags 23 rows and not one of them carries a printed number, which is
  // the tell that a real question was never involved.
  if ((stem.match(PROSE) ?? []).length < 3 && !MATHS.test(stem)) {
    flags.push({
      code: 'stem_is_not_a_question',
      detail: `nothing asked: "${stem.slice(0, 40)}"`,
      severity: 'high',
    })
  }

  // Reading passages get captured as questions when the extractor cannot tell
  // where the passage stops. A long stem that never asks anything is the tell.
  if (normalizedStem.length > 600 && !HAS_QUESTION_SHAPE.test(stem)) {
    flags.push({
      code: 'stem_reads_like_passage',
      detail: `${normalizedStem.length} characters with no question mark`,
      severity: 'low',
    })
  }

  return flags
}

/**
 * Whether the flags justify spending a re-read on this question.
 *
 * One high-severity flag is enough on its own. Low-severity ones are only
 * suggestive, so it takes two to act: a stem that merely ends without
 * punctuation is not worth re-reading a page over.
 */
export function worthRereading(flags: ValidationFlag[]): boolean {
  if (flags.some((f) => f.severity === 'high')) return true
  return flags.filter((f) => f.severity === 'low').length >= 2
}
