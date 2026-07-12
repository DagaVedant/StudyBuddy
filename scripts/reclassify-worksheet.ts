import { config } from 'dotenv'

config({ path: '.env.local' })

import postgres from 'postgres'

/**
 * Clears a worksheet's topic assignments and queues a classify-only job.
 *
 * For measuring a taxonomy change against the same questions — re-extracting
 * would change the questions too, so any movement in the coarse count could
 * not be attributed to the tree.
 *
 * The job is queued with its checkpoint already at the last page, so the
 * worker skips extraction entirely and goes straight to classification.
 *
 * Usage: npx tsx scripts/reclassify-worksheet.ts <id|title-substring>
 */
async function main() {
  const target = process.argv[2]
  if (!target) throw new Error('Usage: npx tsx scripts/reclassify-worksheet.ts <id|title>')

  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false })

  const [sheet] = await sql<{ id: string; title: string; user_id: string; pages: number }[]>`
    select w.id, w.title, w.user_id,
           (select count(*) from worksheet_pages p where p.worksheet_id = w.id)::int as pages
    from worksheets w
    where w.id::text = ${target} or w.title ilike ${'%' + target + '%'}
    order by w.created_at desc limit 1
  `

  if (!sheet) {
    console.log(`No worksheet matching "${target}".`)
    await sql.end()
    return
  }

  const [{ count: cleared }] = await sql<{ count: string }[]>`
    with gone as (
      delete from question_topics qt
      using questions q
      where qt.question_id = q.id and q.worksheet_id = ${sheet.id}
      returning 1
    )
    select count(*)::text as count from gone
  `

  await sql`
    update processing_jobs set status = 'cancelled'
    where worksheet_id = ${sheet.id} and status in ('pending','claimed','running')
  `

  await sql`
    insert into processing_jobs
      (id, worksheet_id, user_id, stage, status, executor, priority, checkpoint)
    values (${crypto.randomUUID()}, ${sheet.id}, ${sheet.user_id},
            'extract', 'pending', 'operator_gpu', 'high',
            ${sql.json({ lastPageNumber: sheet.pages })})
  `

  await sql`update worksheets set status = 'queued' where id = ${sheet.id}`

  console.log(
    `"${sheet.title}" — cleared ${cleared} topic assignments, queued classification only.`,
  )
  await sql.end()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
