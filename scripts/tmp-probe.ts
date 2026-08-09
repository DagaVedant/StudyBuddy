import { config } from 'dotenv'

config({ path: '.env.local' })

import postgres from 'postgres'

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false })

  const title = process.argv[2]
  const page = Number(process.argv[3] ?? 0)
  const chars = Number(process.argv[4] ?? 1200)

  const rows = await sql<{ page_number: number; ocr_text: string | null }[]>`
    select p.page_number, p.ocr_text
    from worksheet_pages p
    join worksheets w on w.id = p.worksheet_id
    where w.title = ${title}
    order by p.page_number
  `

  for (const row of rows) {
    if (page && row.page_number !== page) continue
    console.log(`\n===== ${title} page ${row.page_number} =====`)
    console.log((row.ocr_text ?? '').slice(0, chars))
  }

  await sql.end()
}

main().catch((error) => {
  console.error('DB probe failed:', error.message)
  process.exit(1)
})
