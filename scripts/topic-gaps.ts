import { config } from 'dotenv'

config({ path: '.env.local' })

import postgres from 'postgres'

/**
 * Where the classifier is struggling, as evidence for growing the taxonomy.
 *
 * Three signals, in increasing order of usefulness:
 *   - abstentions: nothing in the tree fit at all
 *   - coarse hits: it landed on a branch instead of a leaf, so the tree stops
 *     one level short of where the question actually lives
 *   - crowding: one leaf absorbing a large share of a subject usually means it
 *     is standing in for several distinct skills
 *
 * Usage: npx tsx scripts/topic-gaps.ts
 */
async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false })

  const [{ total }] = await sql<{ total: number }[]>`
    select count(*)::int as total from questions
  `
  const [{ tagged }] = await sql<{ tagged: number }[]>`
    select count(distinct question_id)::int as tagged from question_topics
  `

  console.log(`questions ${total}, tagged ${tagged}, untagged ${total - tagged}\n`)

  console.log('=== assigned topics, most used first ===')
  const assigned = await sql`
    select t.name, t.depth, t.is_leaf, t.subject_root,
           count(*)::int as n,
           round(avg(qt.confidence)::numeric, 2) as conf
    from question_topics qt
    join topics t on t.id = qt.topic_id
    group by t.name, t.depth, t.is_leaf, t.subject_root
    order by n desc
  `
  for (const row of assigned) {
    const kind = row.is_leaf ? 'leaf ' : 'COARSE'
    console.log(
      `  ${String(row.n).padStart(3)}  ${kind} d${row.depth}  ${row.subject_root} › ${row.name}  (conf ${row.conf})`,
    )
  }

  console.log('\n=== proposals the classifier wrote when it abstained ===')
  const proposals = await sql`
    select p.proposed_name, count(*)::int as n
    from topic_proposals p
    group by p.proposed_name
    order by n desc
  `
  if (proposals.length === 0) console.log('  (none)')
  for (const row of proposals) {
    console.log(`  ${String(row.n).padStart(3)}  ${row.proposed_name}`)
  }

  console.log('\n=== untagged questions (sample) ===')
  const untagged = await sql`
    select q.prompt_text
    from questions q
    where not exists (select 1 from question_topics qt where qt.question_id = q.id)
    limit 40
  `
  for (const row of untagged) {
    console.log(`  ${String(row.prompt_text).replace(/\s+/g, ' ').slice(0, 105)}`)
  }

  await sql.end()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
