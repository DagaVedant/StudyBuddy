import { config } from 'dotenv'

config({ path: '.env.local' })

import postgres from 'postgres'

async function main() {
  const target = process.argv[2]
  if (!target) throw new Error('Usage: npx tsx scripts/check-worksheet-attempts.ts <title>')

  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false })

  const rows = await sql`
    select w.id, w.title,
           (select count(*) from questions q where q.worksheet_id = w.id)::int as questions,
           (select count(*) from attempts a
              join questions q on q.id = a.question_id
             where q.worksheet_id = w.id)::int as attempts,
           (select count(*) from review_cards c
              join questions q on q.id = c.question_id
             where q.worksheet_id = w.id)::int as cards
    from worksheets w
    where w.title ilike ${'%' + target + '%'}
  `

  for (const row of rows) {
    console.log(
      `${row.title}: ${row.questions} questions, ${row.attempts} attempts, ${row.cards} review cards`,
    )
  }

  await sql.end()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
