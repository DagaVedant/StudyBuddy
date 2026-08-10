/**
 * Removes questions that were read off an answer key or solutions page.
 *
 * Extraction now refuses to store these ({@link isAnswerPage}, in
 * lib/questions/answer-key.ts), but sheets processed before that still hold
 * them: sixteen rows across the Edison run, with prompts like `Answer: D` and
 * the printed numbers of the questions they were the answers to. Those numbers
 * are the damage. The coverage audit counted them as the questions they
 * answered and reported `test8_15` at 100 % recall while the sheet was missing
 * eight of its fifteen.
 *
 *   npx tsx scripts/purge-answer-page-rows.ts                    # dry run, all sheets
 *   npx tsx scripts/purge-answer-page-rows.ts edison_topic_test4 # dry run, one prefix
 *   npx tsx scripts/purge-answer-page-rows.ts edison --apply --out C:\backup.json
 *
 * Dry run by default. Everything it deletes is written to the backup file
 * first, options and topics included, because `questions` cascades to five
 * tables and a delete here is not recoverable from the row alone.
 *
 * Refuses any row a student has touched. An answer-key row should never have an
 * attempt or a review card against it, and if one does then either the
 * detection is wrong or somebody has been practising against it; both are
 * reasons to stop rather than to delete.
 */
import { config } from 'dotenv'

config({ path: '.env.local' })

import { writeFile } from 'node:fs/promises'

import postgres from 'postgres'

import { isAnswerPage } from '../lib/questions/answer-key'
import { confirmDestructive, databaseHost, requireLocalDb } from './_confirm'

interface Candidate {
  worksheetId: string
  worksheet: string
  questionId: string
  pageNumber: number
  printedNumber: number | null
  promptText: string
  choices: { label: string; text: string; isCorrect: boolean }[]
  topics: string[]
  attempts: number
  reviewCards: number
  explanations: number
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function option(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? null : (process.argv[index + 1] ?? null)
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set.')

  const prefix = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? ''
  const apply = flag('apply')
  const out = option('out') ?? `answer-page-rows-backup.json`

  // The dry run is read-only and useful against production, so only the writing
  // form is gated. With no prefix the query is `title like '%'`, which is every
  // worksheet on every account, and `--apply` is one word away from the dry run
  // the operator has just read and agreed with.
  if (apply) requireLocalDb()

  const sql = postgres(url, { max: 1, prepare: false })

  const pages = await sql<
    {
      worksheet_id: string
      worksheet: string
      page_id: string
      page_number: number
      ocr_text: string | null
    }[]
  >`
    select w.id as worksheet_id, w.title as worksheet,
           p.id as page_id, p.page_number, p.ocr_text
    from worksheet_pages p
    join worksheets w on w.id = p.worksheet_id
    where w.title like ${prefix + '%'}
    order by w.created_at, p.page_number
  `

  const answerPages = pages.filter((page) => isAnswerPage(page.ocr_text ?? ''))

  if (answerPages.length === 0) {
    console.log(`No answer key or solutions pages under "${prefix}".`)
    await sql.end()
    return
  }

  const candidates: Candidate[] = []

  for (const page of answerPages) {
    const rows = await sql<
      {
        id: string
        printed_number: number | null
        prompt_text: string
        attempts: number
        review_cards: number
        explanations: number
      }[]
    >`
      select q.id, q.printed_number, q.prompt_text,
             (select count(*) from attempts a where a.question_id = q.id)::int as attempts,
             (select count(*) from review_cards r where r.question_id = q.id)::int as review_cards,
             (select count(*) from explanations e where e.question_id = q.id)::int as explanations
      from questions q
      where q.page_id = ${page.page_id}
      order by q.ordinal
    `

    for (const row of rows) {
      const choices = await sql<{ label: string; text: string; is_correct: boolean }[]>`
        select label, text, is_correct from answer_choices where question_id = ${row.id}
      `
      const topics = await sql<{ slug: string }[]>`
        select t.slug from question_topics qt
        join topics t on t.id = qt.topic_id
        where qt.question_id = ${row.id}
      `

      candidates.push({
        worksheetId: page.worksheet_id,
        worksheet: page.worksheet,
        questionId: row.id,
        pageNumber: page.page_number,
        printedNumber: row.printed_number,
        promptText: row.prompt_text,
        choices: choices.map((c) => ({ label: c.label, text: c.text, isCorrect: c.is_correct })),
        topics: topics.map((t) => t.slug),
        attempts: row.attempts,
        reviewCards: row.review_cards,
        explanations: row.explanations,
      })
    }
  }

  const touched = candidates.filter(
    (row) => row.attempts > 0 || row.reviewCards > 0 || row.explanations > 0,
  )
  const removable = candidates.filter((row) => !touched.includes(row))

  console.log(
    `${answerPages.length} answer key or solutions page(s) under "${prefix}", ` +
      `holding ${candidates.length} question row(s).\n`,
  )

  for (const row of removable) {
    console.log(
      `  ${row.worksheet} p${row.pageNumber} #${row.printedNumber ?? '-'}  ` +
        `${row.choices.length} option(s), ${row.topics.length} topic(s)`,
    )
    console.log(`      ${row.promptText.replace(/\s+/g, ' ').slice(0, 96)}`)
  }

  for (const row of touched) {
    console.log(
      `  KEPT ${row.worksheet} p${row.pageNumber} #${row.printedNumber ?? '-'}: ` +
        `${row.attempts} attempt(s), ${row.reviewCards} review card(s), ` +
        `${row.explanations} explanation(s). A student has touched this; ` +
        `check it by hand.`,
    )
  }

  if (removable.length === 0) {
    console.log('\nNothing to remove.')
    await sql.end()
    return
  }

  if (!apply) {
    console.log(`\n${removable.length} row(s) would be deleted. Re-run with --apply.`)
    await sql.end()
    return
  }

  await confirmDestructive([
    '',
    `  database:  ${databaseHost(url)}`,
    `  title:     ${prefix ? `${prefix}*` : 'EVERY worksheet on every account'}`,
    `  deleting:  ${removable.length} question row(s), listed above`,
    `  backup:    ${out}`,
  ])

  await writeFile(out, JSON.stringify(removable, null, 2), 'utf8')
  console.log(`\nBacked up ${removable.length} row(s) to ${out}`)

  const deleted = await sql<{ id: string }[]>`
    delete from questions
    where id in ${sql(removable.map((row) => row.questionId))}
    returning id
  `

  console.log(`Deleted ${deleted.length} row(s).`)

  await sql.end()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
