import { config } from 'dotenv'

config({ path: '.env.local' })

import { and, asc, eq, isNotNull, like, notInArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'

import { answerChoices, questions, worksheetPages, worksheets } from '../../lib/db/schema'
import type { Db } from '../../lib/db/types'
import { promptSimilarity } from '../../lib/questions/duplicates'
import { questionsOnPage } from '../../lib/questions/numbering'
import { hashQuestion, normalizeChoiceLabel } from '../../lib/questions/shape'
import { runRepairPasses } from '../../lib/worker/pipeline'
import { confirmDestructive, databaseHost, requireLocalDb } from '../_confirm'
import { connect } from '../db'

const SAME_QUESTION = 0.8

interface Fix {
  worksheetId: string
  worksheet: string
  questionId: string
  pageNumber: number
  printedNumber: number | null
  matchedNumber: number
  promptText: string
  options: { label: string; text: string }[]
}

interface Skip {
  worksheet: string
  printedNumber: number | null
  reason: string
}

async function plan(db: Db, prefix: string): Promise<{ fixes: Fix[]; skips: Skip[] }> {
  const sheets = await db
    .select({ id: worksheets.id, title: worksheets.title })
    .from(worksheets)
    .where(like(worksheets.title, `${prefix}%`))
    .orderBy(asc(worksheets.createdAt))

  const fixes: Fix[] = []
  const skips: Skip[] = []

  for (const sheet of sheets) {
    const pages = await db
      .select({
        id: worksheetPages.id,
        pageNumber: worksheetPages.pageNumber,
        ocrText: worksheetPages.ocrText,
      })
      .from(worksheetPages)
      .where(eq(worksheetPages.worksheetId, sheet.id))
      .orderBy(asc(worksheetPages.pageNumber))

    const printedOn = new Map(
      pages.map((page) => [page.id, questionsOnPage(page.ocrText ?? '')]),
    )
    const numberOf = new Map(pages.map((page) => [page.id, page.pageNumber]))

    const withChoices = db
      .select({ questionId: answerChoices.questionId })
      .from(answerChoices)

    const bare = await db
      .select({
        id: questions.id,
        printedNumber: questions.printedNumber,
        promptText: questions.promptText,
        pageId: questions.pageId,
      })
      .from(questions)
      .where(
        and(
          eq(questions.worksheetId, sheet.id),
          notInArray(questions.id, withChoices),
          isNotNull(questions.pageId),
        ),
      )
      .orderBy(asc(questions.ordinal))

    for (const row of bare) {
      const note = (reason: string) =>
        skips.push({ worksheet: sheet.title, printedNumber: row.printedNumber, reason })

      const onPage = printedOn.get(row.pageId!) ?? []

      const matches = onPage
        .filter(
          (question) => row.printedNumber === null || question.number === row.printedNumber,
        )
        .map((question) => ({ question, alike: promptSimilarity(row.promptText, question.stem) }))
        .sort((a, b) => b.alike - a.alike)

      if (matches.length === 0) {
        note('the page text prints nothing under that number')
        continue
      }

      const best = matches[0]

      if (best.alike < SAME_QUESTION) {
        note(`the stored prompt and the printed one only match ${best.alike.toFixed(2)}`)
        continue
      }

      if (best.question.options.length === 0) {
        note('the page prints no options under it')
        continue
      }

      fixes.push({
        worksheetId: sheet.id,
        worksheet: sheet.title,
        questionId: row.id,
        pageNumber: numberOf.get(row.pageId!) ?? 0,
        printedNumber: row.printedNumber,
        matchedNumber: best.question.number,
        promptText: row.promptText,
        options: best.question.options,
      })
    }
  }

  return { fixes, skips }
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set.')

  const prefix = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? ''
  const apply = process.argv.includes('--apply')

  if (apply) requireLocalDb()

  const sql = connect(url)
  const db = drizzle(sql) as unknown as Db

  const { fixes, skips } = await plan(db, prefix)

  for (const fix of fixes) {
    const number =
      fix.printedNumber === null ? `(unnumbered, matched #${fix.matchedNumber})` : `#${fix.printedNumber}`

    console.log(
      `  ${fix.worksheet} p${fix.pageNumber} ${number}: ` +
        fix.options.map((option) => `${option.label}. ${option.text}`).join('  '),
    )
  }

  for (const skip of skips) {
    console.log(`  SKIP ${skip.worksheet} #${skip.printedNumber ?? '-'}: ${skip.reason}`)
  }

  if (fixes.length === 0) {
    console.log(`\nNothing to repair under "${prefix}".`)
    await sql.end()
    return
  }

  if (!apply) {
    console.log(`\n${fixes.length} question(s) would get their options back. Re-run with --apply.`)
    await sql.end()
    return
  }

  await confirmDestructive([
    '',
    `  database:  ${databaseHost(url)}`,
    `  titles:    ${prefix ? `${prefix}*` : 'EVERY worksheet on every account'}`,
    `  repairing: ${fixes.length} question(s), listed above`,
  ])

  for (const fix of fixes) {
    await db.insert(answerChoices).values(
      fix.options.map((option) => ({
        questionId: fix.questionId,
        label: normalizeChoiceLabel(option.label),
        text: option.text,
        isCorrect: false,
      })),
    )

    await db
      .update(questions)
      .set({
        contentHash: hashQuestion(fix.promptText, fix.options),
        questionType: 'multiple_choice',
      })
      .where(eq(questions.id, fix.questionId))
  }

  console.log(`\nRestored options for ${fixes.length} question(s).`)

  for (const worksheetId of new Set(fixes.map((fix) => fix.worksheetId))) {
    const counts = await runRepairPasses(db, worksheetId, {
      only: ['carried', 'answers'],
      log: '  ',
    })
    console.log(
      `  ${worksheetId}: recovered ${counts.recovered} carried run(s), ` +
        `answered ${counts.answered}`,
    )
  }

  await sql.end()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
