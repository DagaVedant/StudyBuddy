import { readFileSync } from 'node:fs'

/**
 * Catches the table count drifting out from under README.md and SETUP.md.
 *
 * It has drifted twice: 19 tables became 21 with a fix that only ever
 * corrected the two numbers on the page, so nothing stopped a third table
 * count from going stale the next time a migration added one. `question_solutions`
 * and `topic_lessons` did exactly that.
 *
 * Counts `pgTable(` calls in the schema rather than trusting either doc, and
 * fails if either file states a different number. Not part of `npm run check`:
 * a docs mismatch is not a code defect the same way a type error is, and
 * fixing it usually means writing a sentence, not running a formatter. Run it
 * by hand after a migration, or add it to CI if drift here matters enough to
 * block a merge.
 *
 *   npx tsx scripts/check-docs.ts
 */

const schema = readFileSync('lib/db/schema.ts', 'utf8')
const tableCount = (schema.match(/=\s*pgTable\(/g) ?? []).length

const files = ['README.md', 'SETUP.md']
let bad = false

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const match = text.match(/creates (\d+) tables/)

  if (!match) {
    console.log(`  skip  ${file}: no "creates N tables" line found`)
    continue
  }

  const stated = Number(match[1])
  if (stated === tableCount) {
    console.log(`  ok    ${file}: says ${stated}, schema has ${tableCount}`)
  } else {
    bad = true
    console.log(`  BAD   ${file}: says ${stated}, schema has ${tableCount}`)
  }
}

if (bad) {
  console.log(`\nUpdate the stale figure(s) above.`)
  process.exit(1)
}

console.log(`\nAll table counts match the schema (${tableCount} tables).`)
