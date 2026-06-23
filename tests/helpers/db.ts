import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { PGlite } from '@electric-sql/pglite'
// PGlite 0.5 moved pgvector into its own package.
import { vector } from '@electric-sql/pglite-pgvector'
import { drizzle } from 'drizzle-orm/pglite'

import * as schema from '@/lib/db/schema'

export type TestDb = ReturnType<typeof drizzle<typeof schema>>

/**
 * Embedded Postgres for tests. Real Postgres semantics (it's the actual engine
 * compiled to WASM), no Docker, no service, and a fresh database per suite.
 *
 * Production still runs postgres.js against Neon — see lib/db/index.ts.
 */
export async function createTestDb(): Promise<{
  db: TestDb
  client: PGlite
  close: () => Promise<void>
}> {
  const client = await PGlite.create({ extensions: { vector } })
  await client.exec('CREATE EXTENSION IF NOT EXISTS vector;')

  /*
   * Every migration in journal order, not just the initial one.
   *
   * This used to hardcode `0000_init.sql`, so the moment a second migration
   * existed the test database silently diverged from production's — the whole
   * suite failed on a column the schema declared and the fixture lacked.
   */
  const journal = JSON.parse(
    await readFile(resolve(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8'),
  ) as { entries: { idx: number; tag: string }[] }

  const migrations = [...journal.entries].sort((a, b) => a.idx - b.idx)

  for (const migration of migrations) {
    const sql = await readFile(
      resolve(process.cwd(), `drizzle/${migration.tag}.sql`),
      'utf8',
    )

    const statements = sql
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean)

    for (const statement of statements) {
      try {
        await client.exec(statement)
      } catch (error) {
        // PGlite's pgvector build has no HNSW support. Vector columns still
        // work; dev/test just falls back to a sequential scan, which is
        // irrelevant at test data sizes. Anything else is a genuine schema
        // error.
        if (/USING hnsw/i.test(statement)) continue
        throw new Error(
          `Migration ${migration.tag} failed:\n${statement}\n\n${(error as Error).message}`,
        )
      }
    }
  }

  const db = drizzle(client, { schema })

  return {
    db,
    client,
    close: () => client.close(),
  }
}
