import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })

import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'

import * as schema from '../lib/db/schema'
import type { Db } from '../lib/db/types'
import { enqueueJob } from '../lib/queue'
import { connect, requireDatabaseUrl } from './db'

/**
 * Hands the questions nobody could answer back to the worker, with the page.
 *
 * A question that turns on a graph, a net or a shaded diagram cannot be
 * answered from its text, and the answering model is text only, so it declines
 * rather than guessing. That is the right behaviour and it leaves a solution
 * row carrying a null answer, which then reads as "already attempted" and is
 * never tried again.
 *
 * The worker can now show it the page. This clears those empty rows so the
 * questions look pending again, and enqueues a job per worksheet to pick them
 * up. Only rows with no answer are touched; a real solution is never discarded.
 *
 * Run from the machine holding the GPU, with the worker running.
 *
 *   npx tsx scripts/requeue-unanswered.ts [--dry-run]
 */

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')

  const client = connect(requireDatabaseUrl())
  const db = drizzle(client, { schema }) as unknown as Db

  const stuck = await db
    .select({
      questionId: schema.questions.id,
      worksheetId: schema.questions.worksheetId,
      userId: schema.questions.userId,
      title: schema.worksheets.title,
    })
    .from(schema.questionSolutions)
    .innerJoin(schema.questions, eq(schema.questions.id, schema.questionSolutions.questionId))
    .innerJoin(schema.worksheets, eq(schema.worksheets.id, schema.questions.worksheetId))
    .where(
      and(
        isNull(schema.questionSolutions.derivedAnswer),
        isNull(schema.questions.correctAnswer),
      ),
    )

  const noRow = await db
    .select({
      questionId: schema.questions.id,
      worksheetId: schema.questions.worksheetId,
      userId: schema.questions.userId,
      title: schema.worksheets.title,
    })
    .from(schema.questions)
    .innerJoin(schema.worksheets, eq(schema.worksheets.id, schema.questions.worksheetId))
    .where(
      and(
        isNull(schema.questions.correctAnswer),
        sql`not exists (
          select 1 from ${schema.questionSolutions}
          where ${schema.questionSolutions.questionId} = ${schema.questions.id}
        )`,
      ),
    )

  const all = [...stuck, ...noRow]
  if (all.length === 0) {
    console.log('Nothing unanswered.')
    await client.end()
    return
  }

  const sheets = new Map<string, { userId: string; title: string; count: number }>()
  for (const row of all) {
    const entry = sheets.get(row.worksheetId) ?? { userId: row.userId, title: row.title, count: 0 }
    entry.count += 1
    sheets.set(row.worksheetId, entry)
  }

  console.log(`${all.length} unanswered question(s) across ${sheets.size} worksheet(s)`)
  for (const [, entry] of sheets) console.log(`  ${entry.count.toString().padStart(3)}  ${entry.title}`)

  if (dryRun) {
    console.log('\n--dry-run, nothing changed.')
    await client.end()
    return
  }

  if (stuck.length > 0) {
    await db.delete(schema.questionSolutions).where(
      inArray(
        schema.questionSolutions.questionId,
        stuck.map((row) => row.questionId),
      ),
    )
    console.log(`\ncleared ${stuck.length} empty solution row(s)`)
  }

  for (const [worksheetId, entry] of sheets) {
    await enqueueJob(db, {
      worksheetId,
      userId: entry.userId,
      stage: 'answer_key',
      executor: 'operator_gpu',
      priority: 'normal',
    })
  }

  console.log(`enqueued ${sheets.size} job(s). Start the worker to pick them up.`)
  await client.end()
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
