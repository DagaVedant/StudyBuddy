import { normalizeForCompare } from './shape'

export interface FoldableQuestion {
  prompt_text: string
  choices: { label: string; text: string }[]
}

const ALPHABETIC = /^[a-z]$/i
const NUMERIC = /^\d+$/

/**
 * Puts numbered source sentences back into the stem they were printed under.
 *
 * A revising-and-editing question prints its raw material as a numbered list:
 * "1. The International Space Station has been inhabited by crew members since
 * 2000." Then it offers lettered options built out of it. Read as a flat
 * list of labelled lines, the two are indistinguishable, and the extractor
 * hands back all seven as though the student had seven options to choose from.
 *
 * The tell is the labelling. A printed answer list is one style all the way
 * down: A B C D, or F G H J, or 1 2 3 4. It is never 1 2 3 A B C D. So when
 * both styles turn up in the same question, the letters are the answer list and
 * the numbers are the material above it.
 *
 * The numbered lines are moved rather than dropped. They are what the stem is
 * pointing at ("combine these sentences" means nothing without them) and a
 * question that has quietly lost its subject is worse than one with too many
 * options, because the extra options are visible in review and the missing
 * sentences are not.
 *
 * Related to `planDuplicateMerges`, which handles the other shape the same page
 * produces: the sentence list arriving as its own separate question rather than
 * folded into this one.
 */
export function foldLeadInChoices<T extends FoldableQuestion>(question: T): T {
  const lettered = question.choices.filter((choice) =>
    ALPHABETIC.test(choice.label.trim()),
  )
  const numbered = question.choices.filter((choice) => NUMERIC.test(choice.label.trim()))

  // Two letters is the floor for calling something an answer list, which keeps
  // this away from a question whose options really are numbered (those carry
  // no letters at all) and away from a single stray label.
  if (lettered.length < 2 || numbered.length === 0) return question

  const stem = question.prompt_text.trim()
  const seen = new Set([normalizeForCompare(stem)].filter(Boolean))
  const lines: string[] = []

  for (const choice of [...numbered].sort(
    (a, b) => Number(a.label) - Number(b.label),
  )) {
    const text = choice.text.trim()
    if (!text) continue

    // Already in the stem means the extractor listed it twice rather than the
    // page printing it twice; appending would say it a third time.
    const normalized = normalizeForCompare(text)
    if (!normalized || [...seen].some((prior) => prior.includes(normalized))) continue

    seen.add(normalized)
    lines.push(`${Number(choice.label)}. ${text}`)
  }

  return {
    ...question,
    prompt_text: [stem, ...lines].join('\n'),
    choices: question.choices.filter((choice) => !NUMERIC.test(choice.label.trim())),
  }
}
