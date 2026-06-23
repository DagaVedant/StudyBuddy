import { config } from 'dotenv'

config({ path: '.env.local' })

import postgres from 'postgres'

/**
 * Re-queues extraction for worksheets that have pages but no questions.
 *
 * Recovers uploads stranded by the Tier C bug, where `complete` marked a
 * worksheet awaiting_review without enqueuing any job. Pages are already
 * stored, so nothing needs re-uploading.
 *
 * Usage: npx tsx scripts/requeue-worksheet.ts [--all | <worksheetId>]
 */
async function main() {
  const arg = process.argv[2] ?? '--all'
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false })

  const stranded = await sql<
    { id: string; title: string; user_id: string; pages: number }[]
  >`
    select w.id, w.title, w.user_id,
           (select count(*) from worksheet_pages p where p.worksheet_id = w.id)::int as pages
    from worksheets w
    where (${arg} = '--all' or w.id = ${arg})
      and not exists (select 1 from questions q where q.worksheet_id = w.id)
      and exists (select 1 from worksheet_pages p where p.worksheet_id = w.id)
      and not exists (
        select 1 from processing_jobs j
        where j.worksheet_id = w.id and j.status in ('pending','claimed','running')
      )
  `

  if (stranded.length === 0) {
    console.log('Nothing stranded — every worksheet with pages has questions or a live job.')
    await sql.end()
    return
  }

  for (const sheet of stranded) {
    await sql`
      insert into processing_jobs
        (id, worksheet_id, user_id, stage, status, executor, priority)
      values (${crypto.randomUUID()}, ${sheet.id}, ${sheet.user_id},
              'extract', 'pending', 'operator_gpu', 'normal')
    `
    await sql`update worksheets set status = 'queued' where id = ${sheet.id}`

    console.log(`queued: ${sheet.title} (${sheet.pages} pages)`)
  }

  console.log(`\n${stranded.length} worksheet(s) queued. Start the worker: npm run worker`)
  await sql.end()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
