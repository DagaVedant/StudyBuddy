import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })

import { desc, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'

import { OllamaProvider } from '../lib/ai/ollama'
import { validated } from '../lib/ai/validated'
import * as schema from '../lib/db/schema'
import type { Db } from '../lib/db/types'
import { deriveSolutions } from '../lib/worker/solutions'
import { connect, requireDatabaseUrl } from './db'

/**
 * Works out the answers for worksheets that were stored before there was
 * anything to work them out with.
 *
 * New worksheets get this from the queue: extraction completes and an
 * `answer_key` job follows it. Everything uploaded before that existed has no
 * such job and never will, so this is the one-off that catches them up.
 *
 * Worksheets with the most unanswered questions first, because that is where
 * the value is. A paper whose own key was read off the PDF already tells the
 * student whether they were right; one with no key at all tells them nothing,
 * and those are the papers this is really for.
 *
 * Safe to interrupt and safe to run twice. `deriveSolutions` reads the
 * questions with no solution row rather than counting through a list, so a run
 * killed halfway resumes where it stopped.
 *
 *   npx tsx scripts/backfill-solutions.ts [--unanswered-only] [--limit 5]
 */

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

async function main(): Promise<void> {
  const unansweredOnly = process.argv.includes('--unanswered-only')
  const limit = Number(arg('limit', '100'))

  const client = connect(requireDatabaseUrl())
  const db = drizzle(client, { schema }) as unknown as Db

  const answerModel =
    process.env.OLLAMA_ANSWER_MODEL ?? process.env.OLLAMA_VISION_MODEL ?? 'gpt-oss:20b'

  const provider = validated(
    new OllamaProvider({
      baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
      visionModel: process.env.OLLAMA_VISION_MODEL ?? 'qwen2.5vl:7b',
      textModel: answerModel,
      answerModel,
      executionSite: 'operator_gpu',
      timeoutMs: 15 * 60_000,
    }),
  )

  const sheets = await db
    .select({
      id: schema.worksheets.id,
      title: schema.worksheets.title,
      questions: sql<number>`count(*)::int`,
      unanswered: sql<number>`count(*) filter (where ${schema.questions.correctAnswer} is null)::int`,
      unsolved: sql<number>`
        count(*) filter (
          where not exists (
            select 1 from ${schema.questionSolutions}
            where ${schema.questionSolutions.questionId} = ${schema.questions.id}
          )
        )::int`,
    })
    .from(schema.questions)
    .innerJoin(schema.worksheets, eq(schema.worksheets.id, schema.questions.worksheetId))
    .groupBy(schema.worksheets.id, schema.worksheets.title)
    .orderBy(desc(sql`count(*) filter (where ${schema.questions.correctAnswer} is null)`))
    .limit(limit)

  const todo = sheets.filter(
    (sheet) => sheet.unsolved > 0 && (!unansweredOnly || sheet.unanswered > 0),
  )

  if (todo.length === 0) {
    console.log('Nothing left to solve.')
    await client.end()
    return
  }

  const total = todo.reduce((sum, sheet) => sum + sheet.unsolved, 0)
  console.log(`${todo.length} worksheet(s), ${total} question(s), model ${answerModel}\n`)

  const totals = { solved: 0, promoted: 0, refused: 0, failed: 0 }

  for (const sheet of todo) {
    const started = Date.now()
    console.log(`${sheet.title}  (${sheet.unsolved} to solve, ${sheet.unanswered} unanswered)`)

    const progress = await deriveSolutions(db, provider, sheet.id, { log: null })

    totals.solved += progress.solved
    totals.promoted += progress.promoted
    totals.refused += progress.refused
    totals.failed += progress.failed

    console.log(
      `  solved ${progress.solved}, answered ${progress.promoted}, ` +
        `declined ${progress.refused}, failed ${progress.failed}, ` +
        `${Math.round((Date.now() - started) / 1000)}s`,
    )
  }

  console.log(
    `\n${totals.solved} solved, ${totals.promoted} answers filled in, ` +
      `${totals.refused} declined, ${totals.failed} failed.`,
  )

  if (totals.refused + totals.failed > 0) {
    console.log(
      'Declined and failed questions have no solution row, so re-running picks them up.',
    )
  }

  await client.end()
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
