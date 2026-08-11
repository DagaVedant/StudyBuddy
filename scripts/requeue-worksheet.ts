import { config } from 'dotenv'

config({ path: '.env.local' })


import { confirmDestructive, databaseHost, requireLocalDb } from './_confirm'
import { openDatabase } from './db'

async function main() {
  // `--yes` belongs to confirmDestructive, so it is skipped when looking for
  // the positional argument. Reading argv[2] directly meant `requeue --yes`
  // searched for a worksheet whose id was the literal string "--yes" and
  // reported nothing stranded, which reads exactly like a clean run.
  const arg = process.argv.slice(2).find((a) => a !== '--yes') ?? '--all'

  requireLocalDb()

  const sql = openDatabase()

  const stranded = await sql<
    { id: string; title: string; user_id: string; email: string; pages: number }[]
  >`
    select w.id, w.title, w.user_id, u.email,
           (select count(*) from worksheet_pages p where p.worksheet_id = w.id)::int as pages
    from worksheets w
    join users u on u.id = w.user_id
    where (${arg} = '--all' or w.id = ${arg})
      and not exists (select 1 from questions q where q.worksheet_id = w.id)
      and exists (select 1 from worksheet_pages p where p.worksheet_id = w.id)
      and not exists (
        select 1 from processing_jobs j
        where j.worksheet_id = w.id and j.status in ('pending','claimed','running')
      )
  `

  if (stranded.length === 0) {
    console.log('Nothing stranded: every worksheet with pages has questions or a live job.')
    await sql.end()
    return
  }

  // Nothing here is deleted, so the sweep felt safe enough to run without
  // looking. It is not: with no argument it queues every account's stranded
  // worksheets, which puts strangers' pages through the operator's GPU and
  // moves their worksheets back to `queued` in their own list. Naming one id
  // is a deliberate enough act to skip the prompt.
  if (arg === '--all') {
    await confirmDestructive([
      `Queue extraction for ${stranded.length} stranded worksheet(s) on ${databaseHost(process.env.DATABASE_URL!)}:`,
      ...stranded.map((sheet) => `  ${sheet.title} (${sheet.pages} pages, ${sheet.email})`),
    ])
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
