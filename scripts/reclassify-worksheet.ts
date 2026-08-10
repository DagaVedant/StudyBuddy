import { config } from 'dotenv'

config({ path: '.env.local' })

import postgres from 'postgres'

import { confirmDestructive, databaseHost, requireLocalDb } from './_confirm'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function main() {
  // The first argument that is not a flag, so `--yes` in any position is not
  // read as the worksheet id.
  const target = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
  if (!target) {
    throw new Error('Usage: npx tsx scripts/reclassify-worksheet.ts <worksheet-id> [--yes]')
  }

  // Titles are no longer accepted. This used to match `ilike '%target%'` across
  // every account and take whichever worksheet was newest, so a one word
  // argument could pick a stranger's sheet and drop its topic assignments,
  // which are what the topic gap and recommendation screens are built from.
  if (!UUID.test(target)) {
    throw new Error(
      `"${target}" is not a worksheet id. Pass the exact id, the uuid in the ` +
        '/worksheets/<id> URL: matching on title picked the wrong sheet.',
    )
  }

  requireLocalDb()

  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false })

  const [sheet] = await sql<
    {
      id: string
      title: string
      user_id: string
      email: string
      pages: number
      topics: number
    }[]
  >`
    select w.id, w.title, w.user_id, u.email,
           (select count(*) from worksheet_pages p where p.worksheet_id = w.id)::int as pages,
           (select count(*) from question_topics qt
              join questions q on q.id = qt.question_id
            where q.worksheet_id = w.id)::int as topics
    from worksheets w
    join users u on u.id = w.user_id
    where w.id = ${target}
  `

  if (!sheet) {
    console.log(`No worksheet with id ${target}.`)
    await sql.end()
    return
  }

  await confirmDestructive([
    `Reclassify "${sheet.title}" (${sheet.pages} pages) on ${databaseHost(process.env.DATABASE_URL!)}`,
    `  owner:    ${sheet.email}`,
    `  clearing: ${sheet.topics} topic assignment(s), then queueing classification again`,
    // The queued job is a full extract job held at the last page, so it still
    // runs the audit re-read, which can replace question rows. It will not
    // touch a question somebody has answered (the job route checks
    // deletableQuestionIds first), but the row itself may be rewritten.
    '  the re-run also re-reads any page the audit doubts, replacing those rows',
  ])

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
    `"${sheet.title}": cleared ${cleared} topic assignments, queued classification only.`,
  )
  await sql.end()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
