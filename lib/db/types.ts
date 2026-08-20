import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'

import type * as schema from './schema'

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>

export function isUniqueViolation(error: unknown): boolean {
  const codes = [error, (error as { cause?: unknown } | null)?.cause]
  return codes.some((candidate) => (candidate as { code?: unknown } | null)?.code === '23505')
}

export function unwrapDriverRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  return ((result as { rows?: T[] }).rows ?? []) as T[]
}
