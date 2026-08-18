export const TRIAL_WORKSHEET_LIMIT = 3

export const TRIAL_EXPLANATION_LIMIT = 20

/*
 * A ceiling on trial extractions per rolling day, across everybody. The
 * per-account limit caps what one student costs; this caps what a bad day
 * costs, since every trial worksheet is read on hardware the operator pays for
 * and stored in a blob store the operator pays for.
 *
 * Unset is 25. "unlimited" removes it. 0 turns the trial off entirely, which is
 * the switch to reach for when the reader is going to be off for a while.
 */
export function trialDailyCeiling(): number {
  const raw = process.env.TRIAL_DAILY_WORKSHEETS?.trim()
  if (!raw) return 25
  if (raw === 'unlimited') return Number.POSITIVE_INFINITY

  const parsed = Number(raw)

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 25
}
