import { config } from 'dotenv'

config({ path: '.env.local' })

import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq, notExists, sql } from 'drizzle-orm'

import { OllamaProvider } from '../../lib/ai/ollama'
import { validated } from '../../lib/ai/parse'
import { classifyQuestion } from '../../lib/classify'
import * as schema from '../../lib/db/schema'
import { questionTopics, questions, topics, worksheets } from '../../lib/db/schema'
import type { Db } from '../../lib/db/types'
import { confirmDestructive, databaseHost, requireLocalDb } from '../_confirm'
import { connect } from '../db'

async function main() {
  const apply = process.argv.includes('--apply')
  const limit = Number(
    process.argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] ?? '100',
  )

  if (apply) requireLocalDb()

  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set.')

  const sql_ = connect(url)
  const db = drizzle(sql_, { schema }) as unknown as Db

  const pending = await db
    .select({
      id: questions.id,
      promptText: questions.promptText,
      userId: questions.userId,
      worksheetId: questions.worksheetId,
      subjectHint: worksheets.subjectHint,
      title: worksheets.title,
    })
    .from(questions)
    .innerJoin(worksheets, eq(worksheets.id, questions.worksheetId))
    .where(
      notExists(
        db
          .select({ questionId: questionTopics.questionId })
          .from(questionTopics)
          .where(eq(questionTopics.questionId, questions.id)),
      ),
    )
    .limit(limit)

  const [leaves] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(topics)
    .where(and(eq(topics.isLeaf, true), sql`${topics.embedding} is not null`))

  const summary = [
    `Database: ${databaseHost(url)}`,
    `Ollama:   ${process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434'}`,
    `Leaves with an embedding to choose from: ${Number(leaves?.value ?? 0)}`,
    '',
    `${pending.length} untagged question(s):`,
    ...pending.map(
      (question) =>
        `  ${question.title.slice(0, 40).padEnd(40)} ${question.promptText.slice(0, 60)}`,
    ),
  ]

  if (!apply) {
    for (const line of summary) console.log(line)
    console.log('\nDry run. Pass --apply to write.')
    await sql_.end()
    return
  }

  await confirmDestructive(summary)

  const model = process.env.OLLAMA_VISION_MODEL ?? 'qwen2.5vl:7b'

  const provider = validated(
    new OllamaProvider({
      baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
      visionModel: model,
      textModel: process.env.OLLAMA_TEXT_MODEL || model,
      executionSite: 'operator_gpu',
      timeoutMs: 5 * 60_000,
    }),
  )

  let tagged = 0
  let coarse = 0
  let failed = 0

  for (const [index, question] of pending.entries()) {
    try {
      const outcome = await classifyQuestion(db, provider, question, question.subjectHint)

      if (outcome.topicId) tagged += 1
      if (outcome.coarse) coarse += 1

      console.log(
        `  ${index + 1}/${pending.length}  ${outcome.topicId ? 'tagged' : 'proposal'}  ${question.id}`,
      )
    } catch (error) {
      failed += 1
      console.log(`  ${index + 1}/${pending.length}  failed  ${question.id}: ${(error as Error).message}`)
    }
  }

  await sql_.end()

  console.log(`\nTagged ${tagged}, raised ${coarse} proposal(s), ${failed} failed.`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
