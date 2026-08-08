import { config } from 'dotenv'

config({ path: '.env.local' })

import { asc, like } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { worksheets } from '../lib/db/schema'
import type { Db } from '../lib/db/types'
import { applyAnswerKey } from '../lib/worker/answer-key'

/**
 * Applies the paper's own answer key to worksheets extracted before the pass
 * existed.
 *
 * The Edison run stored 288 questions across fourteen sheets without a single
 * correct answer between them, because the stage meant to read the key was
 * declared and never implemented. The keys were on the pages the whole time, so
 * nothing needs re-extracting, only re-reading.
 *
 *   npx tsx scripts/backfill-answer-keys.ts             # every worksheet
 *   npx tsx scripts/backfill-answer-keys.ts edison_     # titles with this prefix
 *
 * Safe to run twice: it reads the same key off the same text and writes the
 * same answer. A key the student entered themselves is left alone.
 */
async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set.')

  const prefix = process.argv[2] ?? ''

  const sql = postgres(url, { max: 1 })
  const db = drizzle(sql) as unknown as Db

  const sheets = await db
    .select({ id: worksheets.id, title: worksheets.title })
    .from(worksheets)
    .where(prefix ? like(worksheets.title, `${prefix}%`) : undefined)
    .orderBy(asc(worksheets.title))

  console.log(`Reading answer keys for ${sheets.length} worksheet(s)...`)

  let total = 0

  for (const sheet of sheets) {
    const { answered } = await applyAnswerKey(db, sheet.id)
    total += answered

    console.log(`  ${String(sheet.title).slice(0, 34).padEnd(36)} ${answered} answered`)
  }

  await sql.end()
  console.log(`Done. ${total} question(s) now carry the paper's answer.`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
