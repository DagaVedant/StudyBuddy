import { config } from 'dotenv'

config({ path: '.env.local' })

import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'

import * as schema from '../lib/db/schema'
import { topics } from '../lib/db/schema'
import type { Db } from '../lib/db/types'
import { demoteParentsWithChildren } from '../lib/taxonomy/leaves'
import { flattenTaxonomy } from '../lib/taxonomy/trees'
import { connect } from './db'

const dryRun = process.argv.includes('--dry-run')

async function main() {
  const flat = flattenTaxonomy()

  const leaves = flat.filter((t) => t.isLeaf)
  const bySubject = new Map<string, { total: number; leaves: number }>()
  for (const t of flat) {
    const entry = bySubject.get(t.subjectRoot) ?? { total: 0, leaves: 0 }
    entry.total += 1
    if (t.isLeaf) entry.leaves += 1
    bySubject.set(t.subjectRoot, entry)
  }

  console.log(`Taxonomy: ${flat.length} nodes, ${leaves.length} classifiable leaves`)
  for (const [subject, counts] of bySubject) {
    console.log(`  ${subject.padEnd(24)} ${counts.total} nodes, ${counts.leaves} leaves`)
  }
  console.log(`  max depth: ${Math.max(...flat.map((t) => t.depth))}`)

  if (dryRun) {
    console.log('\n--dry-run: nothing written.')
    return
  }

  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local first.')
  }

  // prepare: false: .env.example recommends a pooled connection string, and
  // prepared statements fail against one. This is one of the two commands the
  // README tells every new user to run.
  const sql = connect(url)
  const db = drizzle(sql, { schema }) as unknown as Db

  // Parents must exist before children can reference them.
  const ordered = [...flat].sort((a, b) => a.depth - b.depth)
  const idBySlug = new Map<string, string>()
  let inserted = 0
  let updated = 0

  for (const node of ordered) {
    const parentId = node.parentSlug ? idBySlug.get(node.parentSlug) : null
    if (node.parentSlug && !parentId) {
      throw new Error(`Parent "${node.parentSlug}" missing for "${node.slug}"`)
    }

    const existing = await db
      .select({ id: topics.id })
      .from(topics)
      .where(eq(topics.slug, node.slug))
      .limit(1)

    if (existing.length) {
      await db
        .update(topics)
        .set({
          name: node.name,
          parentId: parentId ?? null,
          depth: node.depth,
          subjectRoot: node.subjectRoot,
          isLeaf: node.isLeaf,
          isCanonical: true,
        })
        .where(eq(topics.slug, node.slug))
      idBySlug.set(node.slug, existing[0].id)
      updated += 1
    } else {
      const [row] = await db
        .insert(topics)
        .values({
          slug: node.slug,
          name: node.name,
          parentId: parentId ?? null,
          depth: node.depth,
          subjectRoot: node.subjectRoot,
          isLeaf: node.isLeaf,
          isCanonical: true,
        })
        .returning({ id: topics.id })
      idBySlug.set(node.slug, row.id)
      inserted += 1
    }
  }

  // After the writes, because the UPDATE above sets `isLeaf` from the taxonomy
  // file, which does not know about topics an admin accepted from the proposal
  // queue. Left alone, a re-seed puts their parents back in the shortlist.
  const demoted = await demoteParentsWithChildren(db)

  await sql.end()

  console.log(`\nSeeded: ${inserted} inserted, ${updated} updated.`)
  if (demoted.length) {
    console.log(`Demoted ${demoted.length} topic(s) that have children: ${demoted.join(', ')}`)
  }
  console.log('Embeddings are left NULL; run `npm run db:embed` to backfill')
  console.log('them before enabling auto-classification.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
