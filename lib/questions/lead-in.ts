import { normalizeForCompare } from './shape'

export interface FoldableQuestion {
  prompt_text: string
  choices: { label: string; text: string }[]
}

const ALPHABETIC = /^[a-z]$/i
const NUMERIC = /^\d+$/

export function foldLeadInChoices<T extends FoldableQuestion>(question: T): T {
  const lettered = question.choices.filter((choice) =>
    ALPHABETIC.test(choice.label.trim()),
  )
  const numbered = question.choices.filter((choice) => NUMERIC.test(choice.label.trim()))

  if (lettered.length < 2 || numbered.length === 0) return question

  const stem = question.prompt_text.trim()
  const seen = new Set([normalizeForCompare(stem)].filter(Boolean))
  const lines: string[] = []

  for (const choice of [...numbered].sort(
    (a, b) => Number(a.label) - Number(b.label),
  )) {
    const text = choice.text.trim()
    if (!text) continue

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
