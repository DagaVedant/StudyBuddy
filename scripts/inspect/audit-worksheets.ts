import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })

import { drizzle } from 'drizzle-orm/postgres-js'

import { looksUnrendered } from '../../lib/questions/math'
import type { Db } from '../../lib/db/types'
import { runRepairPasses } from '../../lib/worker/pipeline'
import { confirmDestructive, databaseHost, requireLocalDb } from '../_confirm'
import { connect } from '../db'

const LIMIT = Number(process.env.AUDIT_LIMIT ?? 3)

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
  const target = process.argv.slice(2).find((arg) => !arg.startsWith('--'))

  if (FIX && !target) {
    throw new Error(
      'AUDIT_FIX=true repairs one named worksheet: npx tsx scripts/inspect/audit-worksheets.ts <worksheet id>. ' +
        'Without an id there is nothing to aim at, and it used to mean the most recent worksheets on the account.',
    )
  }

  if (FIX) requireLocalDb()

  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local first.')

  const sql = connect(url)
  const orm = drizzle(sql) as unknown as Db

  const sheets = target
    ? await sql`
        select id, title, status, page_count, expected_question_count as expected
        from worksheets where id = ${target}`
    : await sql`
        select id, title, status, page_count, expected_question_count as expected
        from worksheets
        where (select count(*) from questions q where q.worksheet_id = worksheets.id) > 0
        order by created_at desc limit ${LIMIT}`

  if (sheets.length === 0) {
    console.log(target ? `No worksheet with id ${target}.` : 'No worksheets with questions found.')
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

    if (expected > 0) {
      const missing: number[] = []
      for (let n = 1; n <= expected; n += 1) if (!distinct.has(n)) missing.push(n)
      const over = [...distinct].filter((n) => n > expected).sort((a, b) => a - b)

      const recall = ((expected - missing.length) / expected) * 100
      console.log(`  recall           ${recall.toFixed(1)}%  (${expected - missing.length}/${expected})`)
      if (missing.length) { console.log(`  MISSING          ${runs(missing)}`); problems += 1 }
      if (over.length) { console.log(`  PAST THE END     ${over.join(', ')}`); problems += 1 }
    }

    const seen = new Map<number, number>()
    for (const n of printed) seen.set(n, (seen.get(n) ?? 0) + 1)
    const dupes = [...seen.entries()].filter(([, c]) => c > 1).map(([n, c]) => `${n}x${c}`)
    if (dupes.length) { console.log(`  DUPLICATED       ${dupes.join(', ')}`); problems += 1 }

    const ordinals = rows.map((r) => r.ordinal)
    const ordDupes = ordinals.filter((n, i) => ordinals.indexOf(n) !== i)
    const contiguous = ordinals.every((n, i) => n === i + 1)
    if (ordDupes.length) { console.log(`  ORDINAL REUSED   ${[...new Set(ordDupes)].join(', ')}`); problems += 1 }
    else if (!contiguous) { console.log(`  ORDINALS NOT 1..N (first break at ${ordinals.findIndex((n, i) => n !== i + 1) + 1})`); problems += 1 }
    else console.log(`  ordinals         1..${rows.length}, clean`)

    const outOfOrder = rows.filter((r, i) => {
      const next = rows[i + 1]
      return next && r.page !== null && next.page !== null && next.page < r.page
    })
    if (outOfOrder.length) { console.log(`  OUT OF PAGE ORDER at ordinal ${outOfOrder.map((r) => r.ordinal).slice(0, 6).join(', ')}`); problems += 1 }

    const markup = rows.filter((r) => looksUnrendered(r.prompt))
    if (markup.length) {
      console.log(`  UNRENDERED MATH  ${markup.length} row(s), e.g. #${markup[0].printed}: ${markup[0].prompt.slice(0, 60)}`)
      problems += 1
    } else console.log(`  maths            clean`)

    const empty = rows.filter((r) => r.prompt.trim().length < 10)
    const noChoices = rows.filter((r) => r.choices === 0)
    console.log(`  choices          ${rows.length - noChoices.length}/${rows.length} have options`)
    if (empty.length) { console.log(`  EMPTY STEMS      ${empty.length}`); problems += 1 }

    console.log(`  COUNT SHOWN      ${rows.length}${expected ? ` (paper has ${expected})` : ''}`)

    if (FIX) {
      
      
      
      await confirmDestructive([
        '',
        `About to repair ${sheet.title} (${sheet.id}) on ${databaseHost(url)}.`,
        'Duplicate rows are deleted, except any an attempt or a review card points at.',
      ])

      const fixed = await runRepairPasses(orm, String(sheet.id), { log: null })
      console.log(
        `  FIXED            rejoined ${fixed.joined} split(s), recovered options for ${fixed.recovered}, ` +
          `re-rendered maths in ${fixed.rendered} row(s), recovered ${fixed.repaired} number(s), ` +
          `merged ${fixed.merged} duplicate(s), renumbered ${fixed.renumbered} row(s)`,
      )
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
