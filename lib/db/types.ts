import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'

import type * as schema from './schema'

/**
 * A database handle, whichever driver is behind it.
 *
 * Deliberately the generic `PgQueryResultHKT` rather than postgres-js's own:
 * production runs on postgres-js and the tests run on PGlite, and every
 * function that takes a `Db` has to accept both. The cost is that `execute()`
 * returns a shape neither driver quite matches, which is what
 * `unwrapDriverRows` in `lib/db/rows.ts` exists to smooth over.
 *
 * This lived in `lib/dashboard/queries.ts` until 2026-08-07, which meant the
 * queue, the quota, the rate limiter and the worker all imported the dashboard
 * — a feature module — in order to name a database handle.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>
