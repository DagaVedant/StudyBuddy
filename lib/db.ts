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

function numberFromEnv(name: string, fallback: number) {
  const raw = process.env[name]
  if (!raw) return fallback

  return Number(raw)
}

let client = globalForDb.__sql

if (!client) {
  let url = connectionString
  if (!url) url = 'postgresql://unset:unset@127.0.0.1:1/unset'

  client = postgres(url, {
    max: numberFromEnv('DATABASE_POOL_MAX', 5),
    prepare: false,
    idle_timeout: numberFromEnv('DATABASE_IDLE_TIMEOUT', 30),
    max_lifetime: numberFromEnv('DATABASE_MAX_LIFETIME', 60 * 30),
    connect_timeout: 15,
  })
}

globalForDb.__sql = client

export const db = drizzle(client, {schema: tables}) as unknown as Db
export type Db = PgDatabase<PgQueryResultHKT, typeof tables>

function hasUniqueCode(value: unknown) {
  if (!value || typeof value !== 'object') return false

  const coded = value as { code?: unknown }

  return coded.code === '23505'
}

export function isUniqueViolation(error: unknown): boolean {
  if (hasUniqueCode(error)) return true

  if (error && typeof error === 'object') {
    const wrapped = error as { cause?: unknown }
    if (hasUniqueCode(wrapped.cause)) return true
  }

  return false
}

export function unwrapDriverRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]

  const wrapped = result as { rows?: T[] }
  if (!wrapped || !wrapped.rows) return []

  return wrapped.rows
}
