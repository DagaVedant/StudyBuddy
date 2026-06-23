import { config } from 'dotenv'

config({ path: '.env.local' })

import postgres from 'postgres'

/**
 * Clears a worksheet's extracted questions and queues a fresh extraction.
 *
 * For re-running a worksheet after an extraction bug fix. Pages are kept, so
 * nothing needs re-uploading; questions and their attempts are deleted, which
 * is why this asks for an explicit id rather than doing every worksheet.
 *
 * Usage: npx tsx scripts/reextract-worksheet.ts <worksheetId|title-substring>
 */
async function main() {
  const target = process.argv[2]
  if (!target) throw new Error('Usage: npx tsx scripts/reextract-worksheet.ts <id|title>')

  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false })

  const [sheet] = await sql<{ id: string; title: string; user_id: string; pages: number }[]>`
    select w.id, w.title, w.user_id,
           (select count(*) from worksheet_pages p where p.worksheet_id = w.id)::int as pages
    from worksheets w
    where w.id::text = ${target} or w.title ilike ${'%' + target + '%'}
    order by w.created_at desc
    limit 1
  `

  if (!sheet) {
    console.log(`No worksheet matching "${target}".`)
    await sql.end()
    return
  }

  const [{ count: removed }] = await sql<{ count: string }[]>`
    with gone as (delete from questions where worksheet_id = ${sheet.id} returning 1)
    select count(*)::text as count from gone
  `

  await sql`
    update processing_jobs set status = 'cancelled'
    where worksheet_id = ${sheet.id} and status in ('pending','claimed','running')
  `

  await sql`
    insert into processing_jobs (id, worksheet_id, user_id, stage, status, executor, priority)
    values (${crypto.randomUUID()}, ${sheet.id}, ${sheet.user_id},
            'extract', 'pending', 'operator_gpu', 'high')
  `

  await sql`update worksheets set status = 'queued' where id = ${sheet.id}`

  console.log(`"${sheet.title}" — ${sheet.pages} pages, removed ${removed} old questions, queued.`)
  await sql.end()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
