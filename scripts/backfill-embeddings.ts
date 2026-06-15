import { config } from 'dotenv'

config({ path: '.env.local' })

import { eq, isNull } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { topics } from '../lib/db/schema'
import { embed } from '../lib/embeddings'
import { flattenTaxonomy } from '../lib/taxonomy/trees'

/**
 * Fills in topic embeddings after seeding (spec §7.3).
 *
 * Auto-classification needs these to build its candidate shortlist, so run
 * this after `npm run db:seed` and before enabling any AI tier.
 */
async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set.')

  const sql = postgres(url, { max: 1 })
  const db = drizzle(sql)

  const pathBySlug = new Map(flattenTaxonomy().map((topic) => [topic.slug, topic.path]))

  const pending = await db
    .select({ id: topics.id, slug: topics.slug, name: topics.name })
    .from(topics)
    .where(isNull(topics.embedding))

  console.log(`Embedding ${pending.length} topics with all-MiniLM-L6-v2 (384d)...`)

  let done = 0
  for (const topic of pending) {
    // Embed the full path, not just the leaf name — "Triangles" alone is
    // ambiguous, "Geometry › Triangles › Triangle angle sum" is not.
    const vector = await embed(pathBySlug.get(topic.slug) ?? topic.name)

    await db.update(topics).set({ embedding: vector }).where(eq(topics.id, topic.id))

    done += 1
    if (done % 25 === 0) console.log(`  ${done}/${pending.length}`)
  }

  await sql.end()
  console.log(`Done. ${done} topics embedded.`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
