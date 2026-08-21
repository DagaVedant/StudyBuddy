import {config} from 'dotenv'

config({path: '.env.local', quiet: true})

import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'

import {connect} from '../db'

interface Journal {
  entries: {idx: number; when: number; tag: string}[]
}

function describe(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return 'the configured database'
  }
}

async function readJournal(): Promise<Journal['entries']> {
  const journal = JSON.parse(
    await readFile(resolve(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8'),
  ) as Journal

  return [...journal.entries].sort((a, b) => a.when - b.when)
}

const UNREACHABLE = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
])

function cannotReach(error: unknown): boolean {
  const code = (error as {code?: string} | null)?.code
  return code !== undefined && UNREACHABLE.has(code)
}

async function lastApplied(url: string): Promise<number | null> {
  const sql = connect(url)

  try {
    const [table] = (await sql`
      select to_regclass('drizzle.__drizzle_migrations') is not null as present
    `) as unknown as {present: boolean}[]

    if (!table.present) return null

    const [row] = (await sql`
      select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1
    `) as unknown as {created_at: string | number | null}[]

    return row?.created_at == null ? null : Number(row.created_at)
  } finally {
    await sql.end()
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL

  if (!url) {
    console.log('No DATABASE_URL set, skipping the migration check.')
    return
  }

  const entries = await readJournal()

  let applied: number | null

  try {
    applied = await lastApplied(url)
  } catch (error: unknown) {
    if (!cannotReach(error)) throw error

    console.log(`Could not reach ${describe(url)}, skipping the migration check.`)
    return
  }

  const pending = entries.filter((entry) => applied === null || applied < entry.when)

  if (pending.length === 0) {
    console.log(`${entries.length} migration(s), all applied to ${describe(url)}.`)
    return
  }

  console.log(`${pending.length} of ${entries.length} migration(s) missing from ${describe(url)}:`)
  for (const entry of pending) console.log(`  ${entry.tag}`)
  console.log('\nApply them with: npm run db:migrate')

  process.exit(1)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
