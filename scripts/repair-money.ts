import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })

import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'

import * as schema from '../lib/db/schema'
import type { Db } from '../lib/db/types'
import { restoreCurrency } from '../lib/questions/money'
import { confirmDestructive } from './_confirm'
import { connect, requireDatabaseUrl } from './db'

/**
 * Puts back the dollar signs `normalizeMath` ate.
 *
 * The inline-maths rule unwraps `$…$`, which is also how money is written, so
 * a sentence pricing two things handed it the prose between them. "Two apples
 * and three bananas cost $2.20" became "cost 2.20". The rule is fixed, but the
 * raw text is never stored, so already-extracted questions cannot be
 * re-derived: they can only be repaired here or re-read from the page.
 *
 * Only inserts a currency symbol before a number that already exists, and only
 * where the question itself proves it is about money: either another price in
 * the same question kept its sign (the last one always did, having no price
 * after it to be eaten by), or the number carries exactly two decimal places.
 * No arithmetic changes, and a question that fails both tests is left alone
 * and printed so a person can look at it.
 *
 * Reports and changes nothing without `--write`.
 *
 *   npx tsx scripts/repair-money.ts [--write]
 */

interface Repair {
  id: string
  title: string
  printedNumber: number | null
  before: string
  after: string
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write')

  const client = connect(requireDatabaseUrl())
  const db = drizzle(client, { schema }) as unknown as Db

  const rows = await db
    .select({
      id: schema.questions.id,
      promptText: schema.questions.promptText,
      printedNumber: schema.questions.printedNumber,
      title: schema.worksheets.title,
    })
    .from(schema.questions)
    .innerJoin(schema.worksheets, eq(schema.worksheets.id, schema.questions.worksheetId))

  const repairs: Repair[] = []

  for (const row of rows) {
    const after = restoreCurrency(row.promptText)
    if (!after || after === row.promptText) continue

    repairs.push({
      id: row.id,
      title: row.title,
      printedNumber: row.printedNumber,
      before: row.promptText,
      after,
    })
  }

  if (repairs.length === 0) {
    console.log('No question is missing a currency symbol.')
    await client.end()
    return
  }

  console.log(`${repairs.length} question(s) to repair:\n`)
  for (const repair of repairs) {
    console.log(`[${repair.title} Q${repair.printedNumber ?? '?'}]`)
    console.log(`  was: ${repair.before}`)
    console.log(`  now: ${repair.after}\n`)
  }

  if (!write) {
    console.log('Nothing written. Re-run with --write to apply.')
    await client.end()
    return
  }

  await confirmDestructive([
    `Rewrite the prompt text of ${repairs.length} question(s)`,
    'Only inserts a currency symbol; no number changes',
  ])

  for (const repair of repairs) {
    await db
      .update(schema.questions)
      .set({ promptText: repair.after })
      .where(eq(schema.questions.id, repair.id))
  }

  console.log(`Repaired ${repairs.length} question(s).`)
  await client.end()
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
