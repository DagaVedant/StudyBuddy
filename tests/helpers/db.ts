import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { drizzle } from 'drizzle-orm/pglite'

import * as schema from '@/lib/db/schema'

export type TestDb = ReturnType<typeof drizzle<typeof schema>>

export async function createTestDb(): Promise<{
  db: TestDb
  client: PGlite
  close: () => Promise<void>
}> {
  const client = await PGlite.create({ extensions: { vector } })
  await client.exec('CREATE EXTENSION IF NOT EXISTS vector;')

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
