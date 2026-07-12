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

    /*
     * Retire connections before the server does.
     *
     * Neon closes idle connections from its side. Left to itself postgres.js
     * keeps them indefinitely and eventually hands out a dead socket, so the
     * next query fails with ECONNRESET — seen live as a 500 from the worker's
     * heartbeat after it had been idle 57 minutes. Any endpoint that goes
     * quiet then wakes up hits this, not just the worker.
     *
     * Reconnecting costs a few tens of milliseconds and only on the first
     * query after a lull, which is far cheaper than a failed request.
     * Settable to 0 for the E2E socket harness, which does not survive its
     * one connection being recycled underneath it.
     */
    idle_timeout: Number(process.env.DATABASE_IDLE_TIMEOUT ?? 30),
    max_lifetime: Number(process.env.DATABASE_MAX_LIFETIME ?? 60 * 30),
    connect_timeout: 15,
  })

if (process.env.NODE_ENV !== 'production') {
  globalForDb.__sql = client
}

export const db = drizzle(client, { schema })
export { client, schema }
