/**
 * Postgres reports a unique violation as SQLSTATE 23505.
 *
 * Checked on the error and on its cause, because production runs on
 * postgres-js and the tests run on PGlite, and only one of them puts the
 * driver error at the top level.
 *
 * Shared rather than reimplemented per caller. This is exactly the two-line
 * check that is easy to write slightly wrong a second time, most likely by
 * checking only the top level and passing every test against PGlite while
 * silently never firing in production, or the reverse.
 */
export function isUniqueViolation(error: unknown): boolean {
  const codes = [error, (error as { cause?: unknown } | null)?.cause]
  return codes.some((candidate) => (candidate as { code?: unknown } | null)?.code === '23505')
}
