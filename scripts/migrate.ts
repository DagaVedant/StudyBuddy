import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'

import {config} from 'dotenv'
import {drizzle} from 'drizzle-orm/postgres-js'
import {migrate} from 'drizzle-orm/postgres-js/migrator'

import {connect} from './db'

export interface MigrateEnv {
  VERCEL_ENV?: string
  MIGRATE_ON_BUILD?: string
}

export function shouldSkipBuildMigration(
  env: MigrateEnv = process.env as MigrateEnv,
): boolean {
  if (!env.VERCEL_ENV) return false
  return env.MIGRATE_ON_BUILD !== '1'
}

export function missingDatabaseUrlIsFatal(
  env: {VERCEL_ENV?: string} = process.env as {VERCEL_ENV?: string},
): boolean {
  return Boolean(env.VERCEL_ENV)
}

config({path: '.env.local'})

async function applyMigrations() {
  if (process.env.SKIP_MIGRATIONS === 'true') {
    console.log('SKIP_MIGRATIONS set, not migrating.')
    return
  }

  const fromBuild = process.argv.includes('--if-configured')

  if (fromBuild && shouldSkipBuildMigration()) {
    console.log(
      `Vercel ${process.env.VERCEL_ENV} deployment: not migrating from the build.\n` +
        'Run `npm run db:migrate` against production first, then deploy.\n' +
        'Set MIGRATE_ON_BUILD=1 to restore the old behaviour.',
    )
    return
  }

  const url = process.env.DATABASE_URL

  if (!url) {
    if (fromBuild) {
      if (missingDatabaseUrlIsFatal()) {
        throw new Error(
          `DATABASE_URL is not set on this ${process.env.VERCEL_ENV} deployment. ` +
            'Add it in the Vercel project settings before deploying.',
        )
      }
      console.log('No DATABASE_URL, skipping migrations.')
      return
    }
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local first.')
  }

  const sql = connect(url)

  await sql`CREATE EXTENSION IF NOT EXISTS vector`

  await migrate(drizzle(sql), {migrationsFolder: './drizzle'})
  await sql.end()

  console.log('Migrations applied.')
}

config({path: '.env.local', quiet: true})
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
  'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'CONNECT_TIMEOUT',
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

async function checkPending(): Promise<void> {
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

const job = process.argv.includes('--check') ? checkPending : applyMigrations

job().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
