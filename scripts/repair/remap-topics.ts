import { config } from 'dotenv'

config({ path: '.env.local' })

import { TOPIC_REMAP } from '../../lib/taxonomy/remap'
import { flattenTaxonomy } from '../../lib/taxonomy/trees'
import { confirmDestructive, databaseHost, requireLocalDb } from '../_confirm'
import { openDatabase } from '../db'

async function main() {
  const apply = process.argv.includes('--apply')

  if (apply) requireLocalDb()

  const sql = openDatabase()

  const canonical = new Set(flattenTaxonomy().map((topic) => topic.slug))

  const idBySlug = new Map<string, string>()
  for (const row of await sql<{ id: string; slug: string }[]>`select id, slug from topics`) {
    idBySlug.set(row.slug, row.id)
  }

  const missing = Object.values(TOPIC_REMAP).filter(
    (to) => to !== null && !idBySlug.has(to),
  )

  if (missing.length) {
    console.log(`${missing.length} target topic(s) are not in the database yet:`)
    for (const slug of new Set(missing)) console.log(`  ${slug}`)
    console.log('\nRun `npm run db:seed` first.')
    await sql.end()
    process.exit(1)
  }

  const moves: { from: string; to: string | null; questions: number; lessons: number }[] = []

  for (const [from, to] of Object.entries(TOPIC_REMAP)) {
    const fromId = idBySlug.get(from)
    if (!fromId) continue

    const [counts] = await sql<{ questions: number; lessons: number }[]>`
      select (select count(*) from question_topics where topic_id = ${fromId})::int as questions,
             (select count(*) from topic_lessons where topic_id = ${fromId})::int as lessons
    `

    if (counts.questions === 0 && counts.lessons === 0) continue

    moves.push({ from, to, questions: counts.questions, lessons: counts.lessons })
  }

  const stale = [...idBySlug.keys()].filter((slug) => !canonical.has(slug))

  const summary = [
    `Database: ${databaseHost(process.env.DATABASE_URL ?? '')}`,
    '',
    `${moves.length} topic(s) carry data and are moving:`,
    ...moves.map(
      (move) =>
        `  ${move.questions} question(s), ${move.lessons} lesson(s)  ${move.from}` +
        `\n      -> ${move.to ?? '(untagged, to be sorted again)'}`,
    ),
    '',
    `${stale.length} topic(s) are no longer in the taxonomy and will be deleted once empty.`,
  ]

  if (!apply) {
    for (const line of summary) console.log(line)
    console.log('\nDry run. Pass --apply to write.')
    await sql.end()
    return
  }

  await confirmDestructive(summary)

  let moved = 0
  let dropped = 0
  let untagged = 0

  for (const move of moves) {
    const fromId = idBySlug.get(move.from)!

    if (move.to === null) {
      const removed = await sql`
        delete from question_topics where topic_id = ${fromId} returning question_id
      `
      untagged += removed.length
      continue
    }

    const toId = idBySlug.get(move.to)!

    const updated = await sql`
      update question_topics qt
      set topic_id = ${toId}
      where qt.topic_id = ${fromId}
        and not exists (
          select 1 from question_topics other
          where other.question_id = qt.question_id and other.topic_id = ${toId}
        )
      returning qt.question_id
    `

    const collided = await sql`
      delete from question_topics where topic_id = ${fromId} returning question_id
    `

    await sql`update topic_lessons set topic_id = ${toId} where topic_id = ${fromId}`

    moved += updated.length
    dropped += collided.length
  }

  await sql`
    update topic_proposals set suggested_parent_id = null
    where suggested_parent_id in (
      select id from topics where slug not in ${sql(
        canonical.size ? [...canonical] : [''],
      )}
    )
  `

  const deleted: string[] = []

  for (;;) {
    const pass = await sql<{ slug: string }[]>`
      delete from topics t
      where t.slug not in ${sql(canonical.size ? [...canonical] : [''])}
        and not exists (select 1 from question_topics qt where qt.topic_id = t.id)
        and not exists (select 1 from topic_lessons l where l.topic_id = t.id)
        and not exists (select 1 from topics child where child.parent_id = t.id)
      returning slug
    `

    if (pass.length === 0) break

    deleted.push(...pass.map((row) => row.slug))
  }

  await sql.end()

  console.log(`\nMoved ${moved} tag(s), dropped ${dropped} that would have duplicated one.`)
  console.log(`Untagged ${untagged} question(s) with no honest home in the new tree.`)
  console.log(`Deleted ${deleted.length} topic(s) that nothing points at.`)
  console.log('\nRun `npm run db:embed` next: a leaf with no embedding cannot be classified.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
