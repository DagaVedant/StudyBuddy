import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { type PgDatabase, type PgQueryResultHKT } from 'drizzle-orm/pg-core'

import * as tables from './schema'

const globalForDb = globalThis as unknown as {
  __sql?: ReturnType<typeof postgres>
}

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  console.warn(
    '[db] DATABASE_URL is not set. The app will build, but any database call will fail. ' +
      'Copy .env.example to .env.local and fill it in.',
  )
}

const client =
  globalForDb.__sql ??
  postgres(connectionString ?? 'postgresql://unset:unset@127.0.0.1:1/unset', {
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    prepare: false,
    idle_timeout: Number(process.env.DATABASE_IDLE_TIMEOUT ?? 30),
    max_lifetime: Number(process.env.DATABASE_MAX_LIFETIME ?? 60 * 30),
    connect_timeout: 15,
  })

globalForDb.__sql = client

export const db = drizzle(client, {schema: tables}) as unknown as Db
export {client}
export type Db = PgDatabase<PgQueryResultHKT, typeof tables>

export function isUniqueViolation(error: unknown): boolean {
  const codes = [error, (error as {cause?: unknown} | null)?.cause]
  return codes.some((candidate) => (candidate as {code?: unknown} | null)?.code === '23505')
}

export function unwrapDriverRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  return ((result as {rows?: T[]}).rows ?? []) as T[]
}
