import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })

import { trimLessonBody } from '../../lib/topics/lesson-body'
import { openDatabase } from '../db'

const COLLECTED = [
  { label: 'examples', pattern: /(^|\n)\s*(#{1,4}\s*|\*\*)\s*(worked\s+)?examples?\b/i },
  {
    label: 'mistakes',
    pattern:
      /(^|\n)\s*(#{1,4}\s*|\*\*)\s*(common\s+)?(errors?|mistakes?|pitfalls?|traps?|things\s+to\s+(avoid|watch))/i,
  },
  { label: 'h1', pattern: /^#\s+\S/ },
]

async function main(): Promise<void> {
  const fix = process.argv.includes('--fix')
  const sql = openDatabase()

  const rows = (await sql`
    select t.id as topic_id, t.name, l.model, l.body_md, l.examples, l.common_errors
    from topic_lessons l join topics t on t.id = l.topic_id
    order by t.name
  `) as unknown as {
    topic_id: string
    name: string
    model: string | null
    body_md: string
    examples: unknown[] | null
    common_errors: unknown[] | null
  }[]

  let bad = 0
  let fixed = 0

  for (const row of rows) {
    let hits = COLLECTED.filter((c) => c.pattern.test(row.body_md)).map((c) => c.label)
    let note = ''

    if (fix && hits.length > 0) {
      const trimmed = trimLessonBody(row.body_md)
      const left = COLLECTED.filter((c) => c.pattern.test(trimmed)).map((c) => c.label)

      if (trimmed.length > 0 && left.length === 0) {
        await sql`update topic_lessons set body_md = ${trimmed} where topic_id = ${row.topic_id}`
        note = ` (repaired, ${row.body_md.length} -> ${trimmed.length} chars, dropped ${hits.join(', ')})`
        fixed += 1
        hits = []
      }
    }

    const thin: string[] = []
    if ((row.examples?.length ?? 0) < 2) thin.push(`${row.examples?.length ?? 0} examples`)
    if ((row.common_errors?.length ?? 0) < 3) thin.push(`${row.common_errors?.length ?? 0} errors`)

    if (hits.length === 0 && thin.length === 0) {
      console.log(`  ok    ${row.name}${note}`)
      continue
    }

    bad += 1
    console.log(
      `  BAD   ${row.name}${note}  ${[...hits.map((h) => `duplicates:${h}`), ...thin].join(', ')}`,
    )
  }

  console.log(
    `\n${rows.length} lesson(s), ${fixed} repaired, ${bad} needing a rewrite.` +
      (bad > 0 ? '\nRegenerate with: npx tsx scripts/generate-lessons.ts --limit N --force' : '') +
      (!fix && bad > 0 ? '\nOr repair in place with --fix (no GPU).' : ''),
  )

  await sql.end()
  process.exit(bad > 0 ? 1 : 0)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
