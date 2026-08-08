import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from './schema'
import type { Db } from './types'

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

// Cached unconditionally, not just outside production: Next.js bundles each
// route/action separately, and each bundle that imports this module gets its
// own copy of this file's module scope even within one running process — so
// without a process-wide cache, every one of those opens its own connection
// pool instead of sharing one.
globalForDb.__sql = client

/**
 * The handle, typed as the driver-agnostic `Db` every caller already wants.
 *
 * `drizzle()` returns `PostgresJsDatabase`, which is `PgDatabase` narrowed to
 * postgres-js's own result type, and `Db` is deliberately the generic one so
 * the PGlite-backed tests can pass their handle to the same functions. The two
 * do not line up, and eighteen call sites used to write the double assertion
 * themselves to say so — eighteen places where type checking was switched off
 * to work around one mismatch. It is asserted once, here.
 */
export const db = drizzle(client, { schema }) as unknown as Db
export { client, schema }
export type { Db }
