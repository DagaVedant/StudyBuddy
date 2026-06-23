/**
 * Trial allowance numbers (spec §3.1), kept in their own module with no
 * database imports so marketing copy and client components can quote the real
 * figure instead of hardcoding one. Drifted copy is how the landing page ended
 * up advertising a limit the code had stopped enforcing.
 */

/**
 * Lifetime, not monthly. Metered in **worksheets** rather than pages: a real
 * practice test is over 100 pages, so a page allowance was spent inside a
 * single upload and the student never saw the loop work end to end.
 */
export const TRIAL_WORKSHEET_LIMIT = 3

export const TRIAL_EXPLANATION_LIMIT = 20
