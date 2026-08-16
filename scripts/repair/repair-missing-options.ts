/**
 * Gives back the answer options that were deleted from stored questions.
 *
 * Forty-nine questions across the Edison run hold no options at all, and every
 * one of them is a question a student marked as verified. That is the whole
 * correlation: 49 verified rows, 49 with no options, and 232 unverified rows
 * with theirs intact. The cause was `questionInputSchema.choices` carrying a
 * `.default([])` that `.partial()` does not suppress, so the verify screen's
 * `{ userVerified: true }` parsed as "replace the choices with none". That bug
 * is fixed. The rows it emptied are not.
 *
 *   npx tsx scripts/repair-missing-options.ts               # dry run, every sheet
 *   npx tsx scripts/repair-missing-options.ts edison_       # dry run, one prefix
 *   npx tsx scripts/repair-missing-options.ts edison_ --apply
 *
 * Reads the options off the page text that is already stored, so no model runs,
 * nothing is re-extracted, and no row is deleted: the verified flags, the topic
 * tags and the answers backfilled from the paper's key all survive, which
 * re-extracting would have thrown away along with the damage.
 *
 * Refuses to attach options to a question whose stored prompt does not match
 * what the page prints under that number. Handing a question someone else's
 * answers is worse than leaving it visibly empty, and it is the failure this
 * whole exercise has been about.
 */
import { config } from 'dotenv'

config({ path: '.env.local' })

import { and, asc, eq, isNotNull, like, notInArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'

import { answerChoices, questions, worksheetPages, worksheets } from '../../lib/db/schema'
import type { Db } from '../../lib/db/types'
import { promptSimilarity } from '../../lib/questions/duplicates-plan'
import { questionsOnPage } from '../../lib/questions/page-options'
import { hashQuestion, normalizeChoiceLabel } from '../../lib/questions/shape'
import { runRepairPasses } from '../../lib/worker/pipeline'
import { confirmDestructive, databaseHost, requireLocalDb } from '../_confirm'
import { connect } from '../db'

/**
 * How alike the stored prompt and the printed one must be.
 *
 * The same measure and the same threshold the duplicate merge uses, for the
 * same reason: two consecutive questions on one maths paper already score
 * about 0.42 against each other, so anything permissive here attaches the
 * wrong options. A stored prompt and the page it was read from differ by
 * reflowed whitespace and the odd repaired symbol, and score well above this.
 */
const SAME_QUESTION = 0.8

interface Fix {
  worksheetId: string
  worksheet: string
  questionId: string
  pageNumber: number
  printedNumber: number | null
  /** The number the page prints it under, which is not always the stored one. */
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

    // Parsed once per page rather than once per question.
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

      // Matched on the number when there is one, and on the words when there
      // is not. A number can appear on a page more than once, in a figure
      // label or a wrapped line, so the stored prompt decides either way; all
      // dropping the number filter does is widen the field it decides between.
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

  // The plan is read-only and useful against production. With no prefix the
  // apply form writes to every account's worksheets, and it does more than
  // insert: it rewrites questionType and then runs two repair passes.
  if (apply) requireLocalDb()

  const sql = connect(url)
  const db = drizzle(sql) as unknown as Db

  const { fixes, skips } = await plan(db, prefix)

  for (const fix of fixes) {
    // A row with no number of its own says which one the page matched it to,
    // because that is the more interesting fact: the number is recoverable too.
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
        // A question with no options was stored as free response, which was a
        // fair reading of a row that had none. The review screen only offers
        // options on a question that claims to have them.
        questionType: 'multiple_choice',
      })
      .where(eq(questions.id, fix.questionId))
  }

  console.log(`\nRestored options for ${fixes.length} question(s).`)

  // The last question on a page keeps only the options printed above the
  // break, so some of these come back short. The carried pass goes and gets
  // the rest off the next page; the answer pass then ticks the option the
  // paper's key names, which it could not do while there were none to tick.
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
