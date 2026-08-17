import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { unwrapDriverRows } from '@/lib/db/rows'
import { processingJobs, topics } from '@/lib/db/schema'
import { flattenTaxonomy } from '@/lib/taxonomy/trees'
import { testEndpointsEnabled } from '@/lib/test-endpoints'

// Everything a run writes is per-account data that a spec file should not inherit
// from the file before it. The canonical taxonomy is the one exception: it is
// seeded once when the test database comes up, and reseeding 341 rows between
// every spec file would cost more than it buys. It gets repaired in place below.
const KEEP = new Set(['topics'])

// A job the previous file started may still be running inside a Next `after()`
// callback, which outlives the response and therefore outlives the test. Wiping
// the tables underneath it leaves rows written after the truncate, so wait for
// the queue to go quiet first.
const IN_FLIGHT = ['claimed', 'running'] as const
const DRAIN_TIMEOUT_MS = 20_000
const DRAIN_POLL_MS = 100

export async function POST() {
  if (!testEndpointsEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const drained = await waitForQuiet()

  await truncateEverythingElse()
  await restoreCanonicalTopics()

  return NextResponse.json({ ok: true, drained })
}

async function waitForQuiet(): Promise<boolean> {
  const deadline = Date.now() + DRAIN_TIMEOUT_MS

  for (;;) {
    const running = await db
      .select({ id: processingJobs.id })
      .from(processingJobs)
      .where(inArray(processingJobs.status, [...IN_FLIGHT]))
      .limit(1)

    if (running.length === 0) return true
    if (Date.now() >= deadline) return false

    await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS))
  }
}

async function truncateEverythingElse(): Promise<void> {
  // Read the table list rather than hard-coding it, so a new table joins the
  // reset the moment it is migrated in instead of quietly leaking state.
  const result = await db.execute(
    sql`select table_name from information_schema.tables
        where table_schema = 'public'
          and table_type = 'BASE TABLE'
          and table_name not like 'drizzle%'`,
  )

  const wanted = unwrapDriverRows<{ table_name: string }>(result)
    .map((row) => row.table_name)
    .filter((name) => !KEEP.has(name))
    .sort()

  if (wanted.length === 0) return

  await db.execute(
    sql`truncate table ${sql.join(
      wanted.map((name) => sql.identifier(name)),
      sql`, `,
    )} cascade`,
  )
}

async function restoreCanonicalTopics(): Promise<void> {
  // Admin tests add topics to the tree and move leaves around. The added ones are
  // never canonical, so dropping them (children follow, parent_id cascades) undoes
  // the additions; what survives is an is_leaf flag flipped on a canonical parent
  // that briefly had a child. Put those back the way the taxonomy defines them.
  await db.delete(topics).where(eq(topics.isCanonical, false))

  const leaves = flattenTaxonomy()
    .filter((node) => node.isLeaf)
    .map((node) => node.slug)

  await db
    .update(topics)
    .set({ isLeaf: true })
    .where(and(eq(topics.isCanonical, true), inArray(topics.slug, leaves)))

  await db
    .update(topics)
    .set({ isLeaf: false })
    .where(and(eq(topics.isCanonical, true), notInArray(topics.slug, leaves)))
}
