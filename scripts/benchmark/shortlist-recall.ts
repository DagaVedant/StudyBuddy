/**
 * Measures whether the topic shortlist contains the right answer at all.
 *
 * Classification has two halves and only one of them is the model's. The
 * shortlist picks the leaf topics the model is allowed to choose between; if
 * the right one is not in there, no prompt, no larger model and no confidence
 * threshold can help, and what comes back is a confident wrong tag. The stored
 * Edison run has "in how many ways can 6 people be seated around a circular
 * table" filed under Geometry and Trigonometry at 0.95, because "circular
 * table" embeds towards circles.
 *
 * So this measures the half that is measurable, against
 * scripts/benchmark/topic-labels.ts, before anyone touches the prompt.
 *
 *   npx tsx scripts/benchmark/shortlist-recall.ts
 *   npx tsx scripts/benchmark/shortlist-recall.ts --limit 50
 *
 * Needs the topics table seeded and embedded (`npm run db:seed`, `npm run
 * db:embed`) and the embedding model available locally.
 */
import { config } from 'dotenv'

config({ path: '.env.local' })

import { drizzle } from 'drizzle-orm/postgres-js'

import { TOPIC_LABELS } from './topic-labels'
import { SHORTLIST_SIZE, shortlistByVector } from '../../lib/classify'
import type { Db } from '../../lib/db/types'
import { embed } from '../../lib/embeddings'
import { connect } from '../db'

const AT = [1, 3, 5, 10, 15, 20, 25, 30, 40, 50]

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? null : (process.argv[index + 1] ?? null)
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set.')

  const sql = connect(url)
  const db = drizzle(sql) as unknown as Db

  const limit = Number(arg('limit') ?? SHORTLIST_SIZE)

  console.log(
    `shortlist of ${limit}, against ${TOPIC_LABELS.length} hand-labelled questions\n`,
  )

  const ranks: (number | null)[] = []

  for (const label of TOPIC_LABELS) {
    const vector = await embed(label.prompt)
    const candidates = await shortlistByVector(db, vector, { limit })

    const rank = candidates.findIndex((candidate) => label.accept.includes(candidate.slug))
    ranks.push(rank === -1 ? null : rank + 1)

    const verdict = rank === -1 ? 'ABSENT' : `rank ${rank + 1}`.padEnd(7)
    console.log(`  ${verdict}  ${label.prompt.slice(0, 78)}`)

    if (rank === -1) {
      console.log(`           wanted one of: ${label.accept.join(', ')}`)
      console.log(`           nearest was:   ${candidates[0]?.slug ?? 'nothing'}`)
    }
  }

  console.log('')
  for (const at of AT) {
    if (at > limit) continue
    const hits = ranks.filter((rank) => rank !== null && rank <= at).length
    const share = ((hits / ranks.length) * 100).toFixed(0)
    console.log(`  recall@${String(at).padEnd(2)} ${hits}/${ranks.length}  (${share}%)`)
  }

  const found = ranks.filter((rank): rank is number => rank !== null)
  if (found.length > 0) {
    const median = [...found].sort((a, b) => a - b)[Math.floor(found.length / 2)]
    console.log(`  median rank of the right topic, when present: ${median}`)
  }

  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
