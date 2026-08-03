import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from './schema'

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

export const db = drizzle(client, { schema })
export { client, schema }
