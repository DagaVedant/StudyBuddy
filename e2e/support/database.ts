import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import postgres from 'postgres'

/**
 * Embedded Postgres exposed over TCP so the real Next.js app can connect to it
 * with an ordinary `postgres://` URL.
 *
 * This is what makes E2E possible without provisioning a database: the app
 * under test is the actual app, running the actual queries, against a real
 * Postgres engine.
 */

export const E2E_PORT = 55432
export const E2E_DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${E2E_PORT}/postgres`

/**
 * Test-only control endpoint.
 *
 * The socket server drops a second concurrent client, and the app already
 * holds a pool on it. Specs therefore query the in-process PGlite directly
 * over loopback HTTP instead of opening a competing Postgres connection.
 */
export const CONTROL_PORT = 55433
export const CONTROL_URL = `http://127.0.0.1:${CONTROL_PORT}`

let db: PGlite | null = null
let server: PGLiteSocketServer | null = null
let control: Server | null = null

async function applyMigration(client: PGlite): Promise<void> {
  const sql = await readFile(resolve(process.cwd(), 'drizzle/0000_init.sql'), 'utf8')

  for (const statement of sql
    .split('--> statement-breakpoint')
    .map((part) => part.trim())
    .filter(Boolean)) {
    try {
      await client.exec(statement)
    } catch (error) {
      // PGlite's pgvector build has no HNSW; vector columns still work.
      if (/USING hnsw/i.test(statement)) continue
      throw new Error(`Migration failed:\n${statement}\n\n${(error as Error).message}`)
    }
  }
}

/**
 * Seeds the taxonomy directly rather than shelling out to the seed script,
 * so setup doesn't depend on a second process connecting over the socket.
 */
async function seedTopics(client: PGlite): Promise<void> {
  const { flattenTaxonomy } = await import('../../lib/taxonomy/trees')

  const flat = [...flattenTaxonomy()].sort((a, b) => a.depth - b.depth)
  const idBySlug = new Map<string, string>()

  for (const node of flat) {
    const parentId = node.parentSlug ? (idBySlug.get(node.parentSlug) ?? null) : null

    // `id` is defaulted by Drizzle ($defaultFn), not by the database, so raw
    // SQL has to supply it.
    const id = crypto.randomUUID()

    await client.query(
      `insert into topics (id, slug, name, parent_id, depth, subject_root, is_leaf, is_canonical)
       values ($1, $2, $3, $4, $5, $6, $7, true)`,
      [id, node.slug, node.name, parentId, node.depth, node.subjectRoot, node.isLeaf],
    )

    idBySlug.set(node.slug, id)
  }
}

/** Short-lived socket client so control queries share the server's queue. */
async function runOverSocket(
  sql: string,
  params: unknown[],
): Promise<Record<string, unknown>[]> {
  const client = postgres(E2E_DATABASE_URL, {
    max: 1,
    prepare: false,
    idle_timeout: 1,
    connect_timeout: 20,
  })

  try {
    return (await client.unsafe(sql, params as never)) as unknown as Record<
      string,
      unknown
    >[]
  } finally {
    await client.end({ timeout: 5 }).catch(() => {})
  }
}

export async function startDatabase(): Promise<void> {
  db = await PGlite.create({ extensions: { vector } })
  await db.exec('CREATE EXTENSION IF NOT EXISTS vector;')

  await applyMigration(db)
  await seedTopics(db)

  server = new PGLiteSocketServer({ db, port: E2E_PORT, host: '127.0.0.1' })
  await server.start()

  control = createServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end()
      return
    }

    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })

    request.on('end', async () => {
      try {
        const { sql, params } = JSON.parse(body) as {
          sql: string
          params?: unknown[]
        }

        // Goes through the socket, NOT db.query() directly. PGlite is
        // single-threaded: a direct call while the socket server has a query
        // in flight corrupts the wire protocol and resets the app's
        // connection. The socket server's queue is the only safe entry point.
        const result = await runOverSocket(sql, params ?? [])

        response
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ rows: result }))
      } catch (error) {
        response
          .writeHead(500, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: (error as Error).message }))
      }
    })
  })

  await new Promise<void>((resolve) =>
    control!.listen(CONTROL_PORT, '127.0.0.1', resolve),
  )
}

export async function stopDatabase(): Promise<void> {
  await new Promise<void>((resolve) => {
    if (!control) return resolve()
    control.close(() => resolve())
  })

  await server?.stop()
  await db?.close()

  control = null
  server = null
  db = null
}
