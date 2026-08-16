/**
 * Worksheets, not pages.
 *
 * The original ask was "10 pages once" and the spec still said so in two places
 * long after the decision recorded at spec.md:677 changed it, which is how an
 * audit came to read the spec and the code as disagreeing about what the trial
 * even is. They do not: a student thinks in worksheets, and metering the thing
 * they think in is the reason this is the unit.
 *
 * What that costs is worth knowing rather than discovering. A credit buys one
 * worksheet of any length up to `MAX_PAGES_PER_UPLOAD`, so three credits is
 * anywhere between 3 and 225 pages of operator GPU time. The bound on spend is
 * therefore the page cap and not this number, and lowering this would not
 * tighten it.
 */
export const TRIAL_WORKSHEET_LIMIT = 3

/**
 * Alongside the worksheets rather than derived from them.
 *
 * spec.md:677: extraction alone does not show the payoff, and the explanation
 * is the thing that sells the product, so the trial deliberately funds twenty
 * of them regardless of how the three worksheets are spent.
 */
export const TRIAL_EXPLANATION_LIMIT = 20
