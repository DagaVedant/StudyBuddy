import {config} from 'dotenv'

config({path: '.env.local'})

import {and, eq, isNull, ne} from 'drizzle-orm'
import {drizzle} from 'drizzle-orm/postgres-js'

import {questions, topics} from '../lib/schema'
import {embed} from '../lib/taxonomy'
import {flattenTaxonomy} from '../lib/taxonomy'
import {connect} from './db'

type Db = ReturnType<typeof drizzle>

const REPORT_EVERY = 25

async function backfillTopics(db: Db): Promise<number> {
  const pathBySlug = new Map(flattenTaxonomy().map((topic) => [topic.slug, topic.path]))

  const pending = await db
    .select({id: topics.id, slug: topics.slug, name: topics.name})
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

    await db.update(topics).set({embedding: vector}).where(eq(topics.id, topic.id))

    done += 1
    if (done % REPORT_EVERY === 0) console.log(`  ${done}/${pending.length}`)
  }

  return done
}

async function backfillQuestions(db: Db): Promise<number> {
  const pending = await db
    .select({id: questions.id, promptText: questions.promptText})
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

    if (vector.every((value) => value === 0)) {
      skipped += 1
      continue
    }

    await db
      .update(questions)
      .set({embedding: vector})
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

  const sql = connect(url)
  const db = drizzle(sql)

  console.log('Model: all-MiniLM-L6-v2 (384d)')

  try {
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
