/**
 * Reads the rows out of whatever `db.execute()` handed back.
 *
 * postgres-js returns the rows as a bare array; PGlite, which the tests run on,
 * returns `{ rows }`. Every raw-SQL call site has to cope with both, and three
 * of them used to carry their own copy of this two-line unwrap, so a fourth
 * driver, or a change in either of these two, meant finding all three.
 */
export function unwrapDriverRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  return ((result as { rows?: T[] }).rows ?? []) as T[]
}
