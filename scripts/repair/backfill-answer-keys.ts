import { config } from 'dotenv'

config({ path: '.env.local' })

import { asc, like } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'

import { worksheets } from '../../lib/db/schema'
import type { Db } from '../../lib/db/types'
import { applyAnswerKey } from '../../lib/worker/answer-key'
import { confirmDestructive, databaseHost, requireLocalDb } from '../_confirm'
import { connect } from '../db'

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set.')

  requireLocalDb()

  const prefix = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? ''

  await confirmDestructive([
    '',
    `  database:  ${databaseHost(url)}`,
    `  titles:    ${prefix ? `${prefix}*` : 'EVERY worksheet on every account'}`,
    '  writing:   correctAnswer and the correct option, read off each paper',
  ])

  const sql = connect(url)
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
