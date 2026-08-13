/**
 * Putting back the dollar signs the inline-maths rule ate.
 *
 * `normalizeMath` unwraps `$...$`, which is also how money is written, so a
 * sentence pricing two things handed it the prose between them and both prices
 * lost their symbol. The rule is fixed. The raw text is never stored, so
 * questions extracted before the fix cannot be re-derived and can only be
 * repaired from what is left of them, which is what this is for.
 *
 * Lives here rather than in the script so it can be tested without the script
 * connecting to a database on import.
 */

/**
 * "cost 8", "costs 2.20", "paid 15": a price with its symbol missing.
 *
 * The two lookaheads are both real. "earns 10% annual interest" matches the
 * verb and is a rate, not a price, and this would have written "earns $10%"
 * onto a question that was never damaged. "for 2 years" is the same trap with
 * a unit instead of a sign. A repair that invents a price is worse than the
 * missing symbol it is fixing, so anything ambiguous is left alone and listed.
 */
const PRICED =
  /\b(cost|costs|earns?|paid|pays?|spends?|sold for|for)\s+(\d+(?:\.\d{2})?)\b(?!\s*%)(?!\s+(?:years?|months?|weeks?|days?|hours?|minutes?|seconds?|items?|tickets?|people|students?|times?|packs?|pieces?))/g

/** The repaired text, or null when nothing about it says money. */
export function restoreCurrency(promptText: string): string | null {
  // A price elsewhere in the same question that kept its symbol. The last one
  // always did: the span runs to the next dollar sign, and there was none.
  const keptOne = /\$\d/.test(promptText)

  let changed = false

  const repaired = promptText.replace(PRICED, (match, verb: string, amount: string) => {
    const twoDecimals = /\.\d{2}$/.test(amount)
    if (!keptOne && !twoDecimals) return match

    changed = true
    return `${verb} $${amount}`
  })

  return changed ? repaired : null
}
