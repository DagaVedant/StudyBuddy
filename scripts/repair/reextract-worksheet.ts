import { config } from 'dotenv'

config({ path: '.env.local' })

import { confirmDestructive, databaseHost, requireLocalDb } from '../_confirm'
import { openDatabase } from '../db'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const USAGE = 'Usage: npx tsx scripts/reextract-worksheet.ts <worksheet-id> [--yes]'

interface Preflight {
  id: string
  title: string
  user_id: string
  owner_email: string
  pages: number
  questions: number
  attempts: number
  cards: number
  explanations: number
}

async function main() {
  const target = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
  if (!target) {
    console.error(USAGE)
    process.exit(1)
  }

  if (!UUID.test(target)) {
    console.error(`"${target}" is not a worksheet id. Titles are not accepted here.`)
    console.error('The id is the last segment of the worksheet URL: /worksheets/<id>')
    console.error(USAGE)
    process.exit(1)
  }

  requireLocalDb()

  const sql = openDatabase()

  const [sheet] = await sql<Preflight[]>`
    select w.id, w.title, w.user_id, u.email as owner_email,
           (select count(*) from worksheet_pages p
              where p.worksheet_id = w.id)::int as pages,
           (select count(*) from questions q
              where q.worksheet_id = w.id)::int as questions,
           (select count(*) from attempts a
              join questions q on q.id = a.question_id
             where q.worksheet_id = w.id)::int as attempts,
           (select count(*) from review_cards c
              join questions q on q.id = c.question_id
             where q.worksheet_id = w.id)::int as cards,
           (select count(*) from explanations e
              join questions q on q.id = e.question_id
             where q.worksheet_id = w.id)::int as explanations
    from worksheets w
    join users u on u.id = w.user_id
    where w.id = ${target}
  `

  if (!sheet) {
    console.log(`No worksheet with id ${target}.`)
    await sql.end()
    process.exit(1)
  }

  await confirmDestructive([
    'About to delete every question on this worksheet and re-extract it.',
    '',
    `  database:      ${databaseHost(process.env.DATABASE_URL!)}`,
    `  worksheet:     ${sheet.title}`,
    `  id:            ${sheet.id}`,
    `  owner:         ${sheet.owner_email}`,
    `  pages:         ${sheet.pages}`,
    '',
    'Deleting the questions also deletes, by cascade:',
    `  questions:     ${sheet.questions}`,
    `  attempts:      ${sheet.attempts}`,
    `  review cards:  ${sheet.cards}`,
    `  explanations:  ${sheet.explanations}`,
  ])

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

  console.log(`"${sheet.title}": ${sheet.pages} pages, removed ${removed} old questions, queued.`)
  await sql.end()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
