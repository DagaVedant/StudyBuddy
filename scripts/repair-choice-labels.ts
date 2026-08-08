import { config } from 'dotenv'

config({ path: '.env.local' })

import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { answerChoices, questions, worksheets } from '../lib/db/schema'
import { normalizeChoiceLabel } from '../lib/questions/shape'

/**
 * Rewrites option labels that arrived with the option stuck to them.
 *
 * `normalizeChoiceLabel` now reduces "A. 60" to "A" as options are ingested, but
 * rows written before that keep the old value, and both the review screen and
 * the dashboard render `{label}. {text}` — so a student reads "A. 60. 60", and
 * nothing matching on the label can find it.
 *
 *   npx tsx scripts/repair-choice-labels.ts            # report only
 *   npx tsx scripts/repair-choice-labels.ts --write    # rewrite them
 *
 * A row is only touched when everything being dropped from the label is already
 * held in the text beside it. Anything else is reported and left alone: a label
 * is not worth repairing at the price of losing the only copy of an option.
 */
async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set.')

  const write = process.argv.includes('--write')

  const sql = postgres(url, { max: 1 })
  const db = drizzle(sql)

  const rows = await db
    .select({
      id: answerChoices.id,
      label: answerChoices.label,
      text: answerChoices.text,
      title: worksheets.title,
    })
    .from(answerChoices)
    .innerJoin(questions, eq(questions.id, answerChoices.questionId))
    .innerJoin(worksheets, eq(worksheets.id, questions.worksheetId))

  let changed = 0
  let skipped = 0

  for (const row of rows) {
    const next = normalizeChoiceLabel(row.label)
    if (next === row.label) continue

    // Whatever the label loses has to survive in the text column.
    const dropped = row.label.slice(next.length).replace(/^\s*[.):\]]\s*/, '').trim()

    if (dropped.length > 0 && !row.text.includes(dropped)) {
      console.log(
        `  SKIP ${row.title}: ${JSON.stringify(row.label)} -> ${JSON.stringify(next)} ` +
          `would lose ${JSON.stringify(dropped)}, text is ${JSON.stringify(row.text)}`,
      )
      skipped += 1
      continue
    }

    if (write) {
      await db
        .update(answerChoices)
        .set({ label: next })
        .where(eq(answerChoices.id, row.id))
    }

    changed += 1
  }

  await sql.end()

  console.log(
    write
      ? `Rewrote ${changed} label(s); left ${skipped} alone.`
      : `${changed} label(s) would change, ${skipped} would be left alone. Re-run with --write.`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
