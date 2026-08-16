import { config } from 'dotenv'
import { openDatabase } from '../db'

config({ path: '.env.local' })


async function main() {
  const prefix = process.argv[2]
  if (!prefix) {
    throw new Error('Usage: npx tsx scripts/tally-questions.ts <title prefix>')
  }

  const sql = openDatabase()

  const [worksheet] = await sql`
    select id, title, page_count from worksheets
    where title like ${`${prefix}%`}
    order by created_at desc limit 1
  `
  if (!worksheet) throw new Error(`no worksheet matching "${prefix}"`)

  console.log(`${worksheet.title}: ${worksheet.page_count} pages\n`)

  const rows = await sql`
    select p.page_number, count(q.id)::int as n
    from worksheet_pages p
    left join questions q on q.page_id = p.id
    where p.worksheet_id = ${worksheet.id}
    group by p.page_number
    order by p.page_number
  `

  let line = ''
  let total = 0
  let empty = 0

  for (const row of rows) {
    total += row.n
    if (row.n === 0) empty += 1
    line += `${String(row.page_number).padStart(3)}:${String(row.n).padStart(2)}  `
    if (row.page_number % 8 === 0) {
      console.log(line)
      line = ''
    }
  }
  if (line) console.log(line)

  console.log(`\ntotal = ${total}   empty pages = ${empty}`)

  const [dupes] = await sql`
    select count(*)::int as n from (
      select content_hash from questions
      where worksheet_id = ${worksheet.id}
      group by content_hash having count(*) > 1
    ) t
  `
  console.log(`prompts appearing more than once = ${dupes.n}`)

  await sql.end()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
