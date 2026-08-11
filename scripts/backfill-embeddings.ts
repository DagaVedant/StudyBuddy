import { config } from 'dotenv'

config({ path: '.env.local' })

import { and, eq, isNull, ne } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'

import { questions, topics } from '../lib/db/schema'
import { embed } from '../lib/embeddings'
import { flattenTaxonomy } from '../lib/taxonomy/trees'
import { connect } from './db'

type Db = ReturnType<typeof drizzle>

/** Reported every this many rows, so a long run shows progress. */
const REPORT_EVERY = 25

async function backfillTopics(db: Db): Promise<number> {
  const pathBySlug = new Map(flattenTaxonomy().map((topic) => [topic.slug, topic.path]))

  const pending = await db
    .select({ id: topics.id, slug: topics.slug, name: topics.name })
    .from(topics)
    .where(isNull(topics.embedding))

  if (pending.length === 0) {
    console.log('Topics: nothing to do.')
    return 0
  }

  console.log(`Topics: embedding ${pending.length}...`)

  let done = 0
  for (const topic of pending) {
    const vector = await embed(pathBySlug.get(topic.slug) ?? topic.name)

    await db.update(topics).set({ embedding: vector }).where(eq(topics.id, topic.id))

    done += 1
    if (done % REPORT_EVERY === 0) console.log(`  ${done}/${pending.length}`)
  }

  return done
}

/**
 * Questions written before the shortlist route started keeping the vector.
 *
 * Until this has run, the cross-worksheet duplicate check (spec §6.3) can only
 * see exact content-hash matches on anything already in the library: the near
 * match half reads `questions.embedding` and every old row holds NULL there.
 *
 * The text embedded is `promptText` and nothing else, which is what the GPU
 * worker sends for a live worksheet. Feeding the choices in as well here would
 * put two different meanings of "the question's vector" in one column and make
 * distances between an old row and a new one meaningless.
 */
async function backfillQuestions(db: Db): Promise<number> {
  const pending = await db
    .select({ id: questions.id, promptText: questions.promptText })
    .from(questions)
    .where(and(isNull(questions.embedding), ne(questions.promptText, '')))

  if (pending.length === 0) {
    console.log('Questions: nothing to do.')
    return 0
  }

  console.log(`Questions: embedding ${pending.length}...`)

  let done = 0
  let skipped = 0

  for (const question of pending) {
    const vector = await embed(question.promptText)

    // `embed` returns a zero vector for text that is empty once trimmed. Cosine
    // distance is undefined against zero and pgvector reports it as NaN, which
    // sorts first and would make a blank row the nearest neighbour of
    // everything. Left NULL instead, which the duplicate check already skips.
    if (vector.every((value) => value === 0)) {
      skipped += 1
      continue
    }

    await db
      .update(questions)
      .set({ embedding: vector })
      .where(eq(questions.id, question.id))

    done += 1
    if (done % REPORT_EVERY === 0) console.log(`  ${done}/${pending.length}`)
  }

  if (skipped > 0) console.log(`  ${skipped} left NULL: nothing to embed in the prompt.`)

  return done
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set.')

  const only = process.argv[2]
  if (only && only !== '--topics' && only !== '--questions') {
    throw new Error(`Unknown argument ${only}. Use --topics or --questions, or neither.`)
  }

  // prepare: false: .env.example recommends a pooled connection string, and
  // prepared statements fail against one.
  const sql = connect(url)
  const db = drizzle(sql)

  console.log('Model: all-MiniLM-L6-v2 (384d)')

  try {
    // Both are resumable: each selects only the rows still holding NULL, so an
    // interrupted run is continued by starting it again.
    const topicCount = only === '--questions' ? 0 : await backfillTopics(db)
    const questionCount = only === '--topics' ? 0 : await backfillQuestions(db)

    console.log(`Done. ${topicCount} topics and ${questionCount} questions embedded.`)
  } finally {
    await sql.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
