import { config } from 'dotenv'

config({ path: '.env.local' })

import { openDatabase } from '../db'

async function main() {
  const [prefix, ...pages] = process.argv.slice(2)
  if (!prefix || pages.length === 0) {
    throw new Error('Usage: npx tsx scripts/peek-page.ts <title prefix> <page>...')
  }

  const sql = openDatabase()

  const [worksheet] = await sql`
    select id, title from worksheets
    where title like ${`${prefix}%`}
    order by created_at desc limit 1
  `
  if (!worksheet) throw new Error(`no worksheet matching "${prefix}"`)

  for (const raw of pages) {
    const pageNumber = Number(raw)

    const [page] = await sql`
      select id, ocr_text from worksheet_pages
      where worksheet_id = ${worksheet.id} and page_number = ${pageNumber}
    `
    if (!page) {
      console.log(`\n--- page ${pageNumber}: not found ---`)
      continue
    }

    const text = String(page.ocr_text ?? '').replace(/\s+/g, ' ').trim()
    console.log(`\n=== page ${pageNumber} =================================`)
    console.log(`TEXT: ${text.slice(0, 400)}`)

    const rows = await sql`
      select ordinal, prompt_text from questions
      where page_id = ${page.id} order by ordinal
    `
    for (const row of rows) {
      const prompt = String(row.prompt_text).replace(/\s+/g, ' ').trim()
      console.log(`  [${row.ordinal}] ${prompt.slice(0, 140)}`)
    }
  }

  await sql.end()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
