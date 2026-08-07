import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })

import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { looksUnrendered } from '../lib/questions/math'
import type { Db } from '../lib/dashboard/queries'
import { renumberQuestions } from '../lib/worker/renumber'

/**
 * Checks recently extracted worksheets for everything known to go wrong.
 *
 * Written against real failures rather than imagined ones: a page returning
 * nothing, a question emitted twice, ordinals handed out by arrival instead of
 * by position, and maths arriving as LaTeX the student cannot read. Each of
 * those shipped at some point, so each is checked every time now.
 *
 *   npx tsx scripts/audit-worksheets.ts        # the three most recent
 *   AUDIT_LIMIT=10 npx tsx scripts/audit-worksheets.ts
 */
const LIMIT = Number(process.env.AUDIT_LIMIT ?? 3)

/**
 * Renumbers as well as reports.
 *
 * Ordinals are safe to rewrite, because they are only a position. Duplicates
 * are not touched even here: choosing which of two copies to destroy is a
 * guess, and the review screen already lets the student delete the wrong one.
 */
const FIX = process.env.AUDIT_FIX === 'true'

interface Row {
  ordinal: number
  printed: number | null
  page: number | null
  prompt: string
  choices: number
}

function runs(numbers: number[]): string {
  if (numbers.length === 0) return 'none'
  const out: string[] = []
  let start = numbers[0]
  let prev = numbers[0]

  for (const n of numbers.slice(1)) {
    if (n === prev + 1) {
      prev = n
      continue
    }
    out.push(start === prev ? `${start}` : `${start}-${prev}`)
    start = n
    prev = n
  }
  out.push(start === prev ? `${start}` : `${start}-${prev}`)
  return out.join(', ')
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { ssl: 'require', max: 1 })
  // renumberQuestions uses the query builder, so it needs a real Drizzle
  // handle rather than the raw client the reporting queries use.
  const orm = drizzle(sql) as unknown as Db

  const sheets = await sql`
    select id, title, status, page_count, expected_question_count as expected
    from worksheets
    where (select count(*) from questions q where q.worksheet_id = worksheets.id) > 0
    order by created_at desc limit ${LIMIT}`

  if (sheets.length === 0) {
    console.log('No worksheets with questions found.')
    await sql.end()
    return
  }

  let problems = 0

  for (const sheet of sheets) {
    const rows = (await sql`
      select q.ordinal, q.printed_number as printed, p.page_number as page,
             q.prompt_text as prompt,
             (select count(*) from answer_choices c where c.question_id = q.id)::int as choices
      from questions q left join worksheet_pages p on p.id = q.page_id
      where q.worksheet_id = ${sheet.id} order by q.ordinal`) as unknown as Row[]

    const expected = Number(sheet.expected) || 0
    const printed = rows.map((r) => r.printed).filter((n): n is number => n !== null)
    const distinct = new Set(printed)

    console.log(`\n${'='.repeat(66)}`)
    console.log(`${sheet.title}`)
    console.log(`  ${sheet.status} | ${sheet.page_count} pages | ${rows.length} rows | expected ${expected || '-'}`)

    // Coverage against the numbers printed on the paper.
    if (expected > 0) {
      const missing: number[] = []
      for (let n = 1; n <= expected; n += 1) if (!distinct.has(n)) missing.push(n)
      const over = [...distinct].filter((n) => n > expected).sort((a, b) => a - b)

      const recall = ((expected - missing.length) / expected) * 100
      console.log(`  recall           ${recall.toFixed(1)}%  (${expected - missing.length}/${expected})`)
      if (missing.length) { console.log(`  MISSING          ${runs(missing)}`); problems += 1 }
      if (over.length) { console.log(`  PAST THE END     ${over.join(', ')}`); problems += 1 }
    }

    // A number appearing twice means one question was stored as two rows.
    const seen = new Map<number, number>()
    for (const n of printed) seen.set(n, (seen.get(n) ?? 0) + 1)
    const dupes = [...seen.entries()].filter(([, c]) => c > 1).map(([n, c]) => `${n}x${c}`)
    if (dupes.length) { console.log(`  DUPLICATED       ${dupes.join(', ')}`); problems += 1 }

    // Ordinals should be 1..N with no repeats: the thing that broke when pages
    // were read in parallel and rows raced for the same counter.
    const ordinals = rows.map((r) => r.ordinal)
    const ordDupes = ordinals.filter((n, i) => ordinals.indexOf(n) !== i)
    const contiguous = ordinals.every((n, i) => n === i + 1)
    if (ordDupes.length) { console.log(`  ORDINAL REUSED   ${[...new Set(ordDupes)].join(', ')}`); problems += 1 }
    else if (!contiguous) { console.log(`  ORDINALS NOT 1..N (first break at ${ordinals.findIndex((n, i) => n !== i + 1) + 1})`); problems += 1 }
    else console.log(`  ordinals         1..${rows.length}, clean`)

    // Ordinal order should follow the paper, not the order pages came back.
    const outOfOrder = rows.filter((r, i) => {
      const next = rows[i + 1]
      return next && r.page !== null && next.page !== null && next.page < r.page
    })
    if (outOfOrder.length) { console.log(`  OUT OF PAGE ORDER at ordinal ${outOfOrder.map((r) => r.ordinal).slice(0, 6).join(', ')}`); problems += 1 }

    // Markup the student would read as nonsense.
    const markup = rows.filter((r) => looksUnrendered(r.prompt))
    if (markup.length) {
      console.log(`  UNRENDERED MATH  ${markup.length} row(s), e.g. #${markup[0].printed}: ${markup[0].prompt.slice(0, 60)}`)
      problems += 1
    } else console.log(`  maths            clean`)

    // Shape of what was captured.
    const empty = rows.filter((r) => r.prompt.trim().length < 10)
    const noChoices = rows.filter((r) => r.choices === 0)
    console.log(`  choices          ${rows.length - noChoices.length}/${rows.length} have options`)
    if (empty.length) { console.log(`  EMPTY STEMS      ${empty.length}`); problems += 1 }

    if (FIX) {
      const { renumbered } = await renumberQuestions(orm, String(sheet.id))
      console.log(`  FIXED            renumbered ${renumbered} row(s)`)
    }
  }

  console.log(`\n${'='.repeat(66)}`)
  console.log(problems === 0 ? 'No problems found.' : `${problems} problem type(s) flagged above.`)
  await sql.end()
}

main().catch((error) => {
  console.error('FAILED:', (error as Error).message)
  process.exit(1)
})
