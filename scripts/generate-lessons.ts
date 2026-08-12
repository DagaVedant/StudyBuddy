import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })

import { drizzle } from 'drizzle-orm/postgres-js'

import { OllamaProvider } from '../lib/ai/ollama'
import { validated } from '../lib/ai/validated'
import type { Db } from '../lib/db/types'
import * as schema from '../lib/db/schema'
import { generateLesson, topicsNeedingLessons } from '../lib/topics/lesson'
import { connect, requireDatabaseUrl } from './db'

/**
 * Writes the topic lessons the dashboard links to.
 *
 * Run on the machine with the GPU, against whichever database it should fill.
 * A lesson is keyed on the topic and shared by everybody who reaches it, so
 * this is the whole cost of the feature: one generation per topic for the
 * install, not one per student.
 *
 * Only topics somebody has actually answered questions in, weakest first.
 * There are 276 leaves and most will never be seen by this install's students;
 * writing the whole tree would spend hours of GPU on lessons nobody opens.
 *
 * Reads and writes lessons only. It cannot touch a student's work, so unlike
 * the repair scripts it is not gated on a local database: filling in teaching
 * material on production is the normal way to use it.
 *
 *   npx tsx scripts/generate-lessons.ts [--limit 5] [--force] [--topic <id>]
 */

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

async function main(): Promise<void> {
  const limit = Number(arg('limit', '5'))
  const force = process.argv.includes('--force')
  const only = arg('topic', '')

  const sql = connect(requireDatabaseUrl())
  const db = drizzle(sql, { schema }) as unknown as Db

  const provider = validated(
    new OllamaProvider({
      baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
      visionModel: process.env.OLLAMA_VISION_MODEL ?? 'qwen2.5vl:7b',
      textModel: process.env.OLLAMA_VISION_MODEL ?? 'qwen2.5vl:7b',
      answerModel: process.env.OLLAMA_ANSWER_MODEL ?? process.env.OLLAMA_VISION_MODEL,
      executionSite: 'operator_gpu',
      timeoutMs: 15 * 60_000,
    }),
  )

  const targets = only
    ? [{ topicId: only, name: only, attempts: 0 }]
    : await topicsNeedingLessons(db, limit)

  if (targets.length === 0) {
    console.log('Every topic with answered questions already has a lesson.')
    await sql.end()
    return
  }

  console.log(`${targets.length} topic(s), model ${provider.model}\n`)

  let written = 0
  for (const target of targets) {
    const started = Date.now()
    process.stdout.write(`  ${target.name} ... `)

    try {
      const lesson = await generateLesson(db, provider, target.topicId, { force })
      const seconds = Math.round((Date.now() - started) / 1000)

      if (!lesson) {
        console.log('already written')
        continue
      }

      written += 1
      console.log(
        `${lesson.bodyMd.length} chars, ${lesson.examples.length} example(s), ` +
          `${lesson.commonErrors.length} error(s), ${seconds}s`,
      )
    } catch (error) {
      // One topic failing is not a reason to stop: the rest are independent and
      // the row is simply absent, so the next run picks it up again.
      console.log(`failed: ${(error as Error).message}`)
    }
  }

  console.log(`\n${written} lesson(s) written.`)
  await sql.end()
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
