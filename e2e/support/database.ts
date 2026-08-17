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

  server = new PGLiteSocketServer({ db, port: E2E_PORT, host: '127.0.0.1' })
  await server.start()

  if (process.env.E2E_DB_DEBUG) attachDiagnostics(server)
}

let heartbeat: NodeJS.Timeout | null = null

function attachDiagnostics(socketServer: PGLiteSocketServer): void {
  const stamp = () => new Date().toISOString().slice(11, 23)

  socketServer.addEventListener('connection', (event) => {
    const detail = (event as CustomEvent).detail as Record<string, unknown>
    console.log(`[e2e-db ${stamp()}] connection from`, detail, socketServer.getStats())
  })

  socketServer.addEventListener('error', (event) => {
    console.log(`[e2e-db ${stamp()}] error`, (event as CustomEvent).detail)
  })

  socketServer.addEventListener('close', () => {
    console.log(`[e2e-db ${stamp()}] server close`)
  })

  let previous = ''

  heartbeat = setInterval(() => {
    const stats = socketServer.getStats()
    const line = JSON.stringify(stats)

    // Only speak up when something changed, or when queries are piling up, so a
    // long run leaves a readable trail rather than a wall of identical lines.
    if (line === previous && stats.queuedQueries === 0) return
    previous = line

    console.log(`[e2e-db ${stamp()}] ${line}`)
  }, 1_000)

  heartbeat.unref()
}

export async function stopDatabase(): Promise<void> {
  if (heartbeat) clearInterval(heartbeat)
  heartbeat = null

  await server?.stop()
  await db?.close()

  server = null
  db = null
}
