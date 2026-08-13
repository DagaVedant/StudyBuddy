import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })

import { openDatabase } from './db'

/**
 * Looks for a lesson that says the same thing twice.
 *
 * The page renders body_md, then the worked examples under their own heading,
 * then the common errors under theirs. A body that carries its own list of
 * examples or pitfalls is shown to the reader alongside the real ones, and the
 * prompt cannot be trusted to have been obeyed: the first attempt used a `##`
 * heading, and once that was forbidden by name the next used a bold line and
 * the same four mistakes.
 *
 * So this matches on the shape rather than on any one label. Run it after
 * generating lessons, and after any change to LESSON_SYSTEM.
 *
 *   npx tsx scripts/check-lessons.ts
 */

/** A heading or a bold line that introduces a collected list. */
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
  const sql = openDatabase()

  const rows = (await sql`
    select t.name, l.model, l.body_md, l.examples, l.common_errors
    from topic_lessons l join topics t on t.id = l.topic_id
    order by t.name
  `) as unknown as {
    name: string
    model: string | null
    body_md: string
    examples: unknown[] | null
    common_errors: unknown[] | null
  }[]

  let bad = 0

  for (const row of rows) {
    const hits = COLLECTED.filter((c) => c.pattern.test(row.body_md)).map((c) => c.label)

    // The prompt asks for exactly two examples and three to five errors. Fewer
    // is not a duplication problem but it is still a lesson worth rewriting.
    const thin: string[] = []
    if ((row.examples?.length ?? 0) < 2) thin.push(`${row.examples?.length ?? 0} examples`)
    if ((row.common_errors?.length ?? 0) < 3) thin.push(`${row.common_errors?.length ?? 0} errors`)

    if (hits.length === 0 && thin.length === 0) {
      console.log(`  ok    ${row.name}`)
      continue
    }

    bad += 1
    console.log(`  BAD   ${row.name}  ${[...hits.map((h) => `duplicates:${h}`), ...thin].join(', ')}`)
  }

  console.log(
    `\n${rows.length} lesson(s), ${bad} needing a rewrite.` +
      (bad > 0 ? '\nRegenerate with: npx tsx scripts/generate-lessons.ts --limit N --force' : ''),
  )

  await sql.end()
  process.exit(bad > 0 ? 1 : 0)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
