import { config } from 'dotenv'
import { openDatabase } from '../db'

config({ path: '.env.local' })


async function main() {
  const sql = openDatabase()

  const sheets = await sql`
    select w.id, w.title, w.status, w.page_count, w.source_type, w.tier_used,
           w.created_at,
           (select count(*) from worksheet_pages p where p.worksheet_id = w.id) as pages_stored,
           (select count(*) from worksheet_pages p
             where p.worksheet_id = w.id and p.ocr_text is not null
               and length(p.ocr_text) > 0) as pages_with_text,
           (select count(*) from questions q where q.worksheet_id = w.id) as questions
    from worksheets w
    order by w.created_at desc
    limit 8
  `

  console.log('=== worksheets ===')
  for (const s of sheets) {
    console.log(
      `${String(s.title).slice(0, 34).padEnd(36)} ${String(s.status).padEnd(16)} ` +
        `declared=${s.page_count} stored=${s.pages_stored} withText=${s.pages_with_text} ` +
        `questions=${s.questions} tier=${s.tier_used} src=${s.source_type}`,
    )
  }

  const jobs = await sql`
    select j.id, j.worksheet_id, w.title, j.stage, j.status, j.executor,
           j.attempt_count, j.progress, j.error, j.checkpoint, j.created_at
    from processing_jobs j
    join worksheets w on w.id = j.worksheet_id
    order by j.created_at desc
    limit 10
  `

  console.log('\n=== jobs ===')
  for (const j of jobs) {
    console.log(
      `${String(j.title).slice(0, 26).padEnd(28)} ${String(j.stage).padEnd(9)} ` +
        `${String(j.status).padEnd(10)} attempts=${j.attempt_count} ` +
        `progress=${Number(j.progress).toFixed(2)} ckpt=${JSON.stringify(j.checkpoint)}`,
    )
    if (j.error) console.log(`    error: ${String(j.error).slice(0, 300)}`)
  }

  const [biggest] = sheets.filter((s) => Number(s.pages_stored) > 5)
  if (biggest) {
    console.log(`\n=== per-page for "${biggest.title}" ===`)
    const pages = await sql`
      select p.page_number, p.width, p.height,
             length(coalesce(p.ocr_text, '')) as text_len,
             p.ocr_engine,
             (select count(*) from questions q where q.page_id = p.id) as questions
      from worksheet_pages p
      where p.worksheet_id = ${biggest.id}
      order by p.page_number
      limit 12
    `
    for (const p of pages) {
      console.log(
        `  page ${String(p.page_number).padStart(3)}  ${p.width}x${p.height}  ` +
          `text=${p.text_len} (${p.ocr_engine})  questions=${p.questions}`,
      )
    }
  }

  await sql.end()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
