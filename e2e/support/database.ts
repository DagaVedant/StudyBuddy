import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'

export const E2E_PORT = 55432
export const E2E_DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${E2E_PORT}/postgres`

let db: PGlite | null = null
let server: PGLiteSocketServer | null = null

interface Journal {
  entries: { idx: number; tag: string }[]
}

/**
 * Applies every migration in journal order, not just the first one.
 *
 * This hardcoded 0000_init.sql for long enough that three later migrations
 * (trial_worksheets_used, printed_number/expected_question_count, the
 * openrouter/google provider enum values) were silently missing from every
 * E2E run — invisibly, since a missing column only surfaces the moment some
 * code tries to write to it, which for trial_worksheets_used is the very
 * first signup. That's most of what "16 E2E specs are failing" actually was.
 */
async function applyMigration(client: PGlite): Promise<void> {
  const journal = JSON.parse(
    await readFile(resolve(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8'),
  ) as Journal

  for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
    const sql = await readFile(resolve(process.cwd(), `drizzle/${entry.tag}.sql`), 'utf8')

    for (const statement of sql
      .split('--> statement-breakpoint')
      .map((part) => part.trim())
      .filter(Boolean)) {
      try {
        await client.exec(statement)
      } catch (error) {
        if (/USING hnsw/i.test(statement)) continue
        throw new Error(
          `Migration ${entry.tag} failed:\n${statement}\n\n${(error as Error).message}`,
        )
      }
    }
  }
}

async function seedTopics(client: PGlite): Promise<void> {
  const { flattenTaxonomy } = await import('../../lib/taxonomy/trees')

  const flat = [...flattenTaxonomy()].sort((a, b) => a.depth - b.depth)
  const idBySlug = new Map<string, string>()

  for (const node of flat) {
    const parentId = node.parentSlug ? (idBySlug.get(node.parentSlug) ?? null) : null

    const id = crypto.randomUUID()

    await client.query(
      `insert into topics (id, slug, name, parent_id, depth, subject_root, is_leaf, is_canonical)
       values ($1, $2, $3, $4, $5, $6, $7, true)`,
      [id, node.slug, node.name, parentId, node.depth, node.subjectRoot, node.isLeaf],
    )

    idBySlug.set(node.slug, id)
  }
}

export async function startDatabase(): Promise<void> {
  db = await PGlite.create({ extensions: { vector } })
  await db.exec('CREATE EXTENSION IF NOT EXISTS vector;')

  await applyMigration(db)
  await seedTopics(db)

  // maxConnections stays at its default of 1: PGlite only tolerates one live
  // session over this socket. A second connection (even a persistent one
  // opened once) corrupts the first rather than being safely queued, despite
  // the library advertising multi-connection support. Anything the test
  // process needs to read or write goes through the app's own connection via
  // the app/api/test/* routes instead of a rival connection here.
  server = new PGLiteSocketServer({ db, port: E2E_PORT, host: '127.0.0.1' })
  await server.start()
}

export async function stopDatabase(): Promise<void> {
  await server?.stop()
  await db?.close()

  server = null
  db = null
}
