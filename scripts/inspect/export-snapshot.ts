import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { config } from 'dotenv'

import { openDatabase } from '../db'

config({ path: '.env.local' })

/*
 * A restore path that does not depend on the database plan. Neon's own
 * point-in-time restore is better when it is available, but "better when
 * available" is not something to find out after losing a term of work, and
 * nothing here needs pg_dump on the PATH.
 *
 * Read-only. Writes one JSON file of the tables that hold work a student did
 * and could not reproduce by hand.
 */
const TABLES = [
  'users',
  'worksheets',
  'worksheet_pages',
  'questions',
  'answer_choices',
  'question_topics',
  'question_solutions',
  'attempts',
  'explanations',
  'review_cards',
  'review_logs',
  'topics',
  'topic_lessons',
  'topic_proposals',
  'user_ai_credentials',
] as const

async function main() {
  const target = resolve(
    process.argv.find((arg) => !arg.startsWith('-') && arg.endsWith('.json')) ??
      `snapshot-${new Date().toISOString().slice(0, 10)}.json`,
  )

  const sql = openDatabase()

  const snapshot: Record<string, unknown[]> = {}

  for (const table of TABLES) {
    const rows = await sql`select * from ${sql(table)}`
    snapshot[table] = rows
    console.log(`  ${String(rows.length).padStart(6)}  ${table}`)
  }

  await sql.end()

  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(
    target,
    JSON.stringify({ takenAt: new Date().toISOString(), tables: snapshot }, null, 1),
  )

  console.log(`\nWrote ${target}`)
  console.log(
    'It holds password hashes and encrypted provider keys. Treat it like the ' +
      'database itself: it is not something to leave in a downloads folder.',
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
