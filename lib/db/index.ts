import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from './schema'

// Next dev reloads modules on every edit; without this the connection count
// climbs until Postgres refuses new clients.
const globalForDb = globalThis as unknown as {
  __sql?: ReturnType<typeof postgres>
}

const connectionString = process.env.DATABASE_URL

// `next build` collects page data without runtime env, and the Auth.js Drizzle
// adapter inspects a real instance at construction, so this cannot be lazy.
// postgres.js does not dial out until the first query, which means an
// unconfigured build still succeeds and only actual queries fail.
if (!connectionString) {
  console.warn(
    '[db] DATABASE_URL is not set. The app will build, but any database call will fail. ' +
      'Copy .env.example to .env.local and fill it in.',
  )
}

const client =
  globalForDb.__sql ??
  postgres(connectionString ?? 'postgresql://unset:unset@127.0.0.1:1/unset', {
    // Configurable because the E2E harness runs against PGlite over a socket,
    // which serves a single connection reliably and resets the rest.
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    // Transaction-mode poolers (Neon, pgBouncer) don't support prepared statements.
    prepare: false,
  })

if (process.env.NODE_ENV !== 'production') {
  globalForDb.__sql = client
}

export const db = drizzle(client, { schema })
export { client, schema }
