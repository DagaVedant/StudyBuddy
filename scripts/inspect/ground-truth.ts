import { config } from 'dotenv'

config({ path: '.env.local' })

import { createRequire } from 'node:module'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'

import { answerChoices, questions, worksheetPages, worksheets } from '../../lib/db/schema'
import type { Db } from '../../lib/db/types'
import { isAnswerPage, mergeAnswerKeys, parseAnswerKey } from '../../lib/questions/answer-key'
import { questionNumbersOn } from '../../lib/questions/page-text'
import { normalizeChoiceLabel } from '../../lib/questions/shape'
import { connect } from '../db'

const ALIASES: Record<string, string> = {}

const STANDARD_FONTS = pathToFileURL(
  join(
    dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    'standard_fonts',
    
    '/',
  ),
).href

interface PaperPage {
  pageNumber: number
  text: string
}

interface Paper {
  name: string
  pages: PaperPage[]
  
  key: Map<number, string>
}

async function readPaper(path: string): Promise<Paper> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

  const data = new Uint8Array(await readFile(path))
  const doc = await pdfjs.getDocument({
    data,
    standardFontDataUrl: STANDARD_FONTS,
    verbosity: 0,
  }).promise

  const pages: PaperPage[] = []

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber)
    const content = await page.getTextContent()

    
    
    
    let text = ''
    let lastY: number | null = null

    for (const item of content.items) {
      if (!('str' in item)) continue
      const y = item.transform[5] as number
      if (lastY !== null && Math.abs(y - lastY) > 1) text += '\n'
      text += item.str
      lastY = y
    }

    pages.push({ pageNumber, text })
    page.cleanup()
  }

  return {
    name: basename(path, '.pdf'),
    pages,
    key: mergeAnswerKeys(pages.map((page) => parseAnswerKey(page.text))),
  }
}

interface Stored {
  worksheetId: string
  title: string
  pageCount: number
  rows: {
    printedNumber: number | null
    promptText: string
    pageNumber: number | null
    correctAnswer: string | null
    answerSource: string
    choiceLabels: string[]
  }[]
  answerPages: number[]
  rowsOnAnswerPages: number
}

async function readStored(db: Db, title: string): Promise<Stored | null> {
  const [sheet] = await db
    .select({ id: worksheets.id, title: worksheets.title })
    .from(worksheets)
    .where(eq(worksheets.title, title))
    .limit(1)

  if (!sheet) return null

  const pages = await db
    .select({
      id: worksheetPages.id,
      pageNumber: worksheetPages.pageNumber,
      ocrText: worksheetPages.ocrText,
    })
    .from(worksheetPages)
    .where(eq(worksheetPages.worksheetId, sheet.id))

  const pageNumberById = new Map(pages.map((page) => [page.id, page.pageNumber]))
  const answerPages = pages
    .filter((page) => isAnswerPage(page.ocrText ?? ''))
    .map((page) => page.pageNumber)
    .sort((a, b) => a - b)

  const rows = await db
    .select({
      id: questions.id,
      printedNumber: questions.printedNumber,
      promptText: questions.promptText,
      pageId: questions.pageId,
      correctAnswer: questions.correctAnswer,
      answerSource: questions.answerSource,
    })
    .from(questions)
    .where(eq(questions.worksheetId, sheet.id))

  const choices =
    rows.length === 0
      ? []
      : await db
          .select({ questionId: answerChoices.questionId, label: answerChoices.label })
          .from(answerChoices)
          .where(
            inArray(
              answerChoices.questionId,
              rows.map((row) => row.id),
            ),
          )

  const labelsFor = new Map<string, string[]>()
  for (const choice of choices) {
    labelsFor.set(choice.questionId, [
      ...(labelsFor.get(choice.questionId) ?? []),
      normalizeChoiceLabel(choice.label),
    ])
  }

  const answerPageSet = new Set(answerPages)
  let rowsOnAnswerPages = 0

  const mapped = rows.map((row) => {
    const pageNumber = row.pageId ? (pageNumberById.get(row.pageId) ?? null) : null
    if (pageNumber !== null && answerPageSet.has(pageNumber)) rowsOnAnswerPages += 1

    return {
      printedNumber: row.printedNumber,
      promptText: row.promptText,
      pageNumber,
      correctAnswer: row.correctAnswer,
      answerSource: row.answerSource,
      choiceLabels: (labelsFor.get(row.id) ?? []).sort(),
    }
  })

  return {
    worksheetId: sheet.id,
    title: sheet.title,
    pageCount: pages.length,
    rows: mapped,
    answerPages,
    rowsOnAnswerPages,
  }
}

interface Diff {
  missing: number[]
  phantom: number[]
  duplicated: number[]
  wrongAnswer: { number: number; paper: string; stored: string | null }[]
  noOptions: number[]
  shortOptions: number[]
  onAnswerPages: number
  
  blame: Map<number, number>
}

function compare(paper: Paper, stored: Stored): Diff {
  const expected = [...paper.key.keys()].sort((a, b) => a - b)

  const byNumber = new Map<number, Stored['rows']>()
  for (const row of stored.rows) {
    if (row.printedNumber === null) continue
    byNumber.set(row.printedNumber, [...(byNumber.get(row.printedNumber) ?? []), row])
  }

  const blame = new Map<number, number>()
  for (const page of paper.pages) {
    for (const number of questionNumbersOn(page.text)) {
      if (!blame.has(number)) blame.set(number, page.pageNumber)
    }
  }

  const missing = expected.filter((number) => !byNumber.has(number))
  const phantom = [...byNumber.keys()].filter((n) => !paper.key.has(n)).sort((a, b) => a - b)
  const duplicated = [...byNumber.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([number]) => number)
    .sort((a, b) => a - b)

  const wrongAnswer: Diff['wrongAnswer'] = []
  const noOptions: number[] = []
  const shortOptions: number[] = []

  
  
  
  
  const optionCount = Math.max(
    ...[...paper.key.values()].map((label) => label.charCodeAt(0) - 'A'.charCodeAt(0) + 1),
  )

  for (const number of expected) {
    const rows = byNumber.get(number)
    if (!rows) continue

    const row = rows[0]
    const want = paper.key.get(number)!
    const labels = row.choiceLabels.map((label) => label.toUpperCase())

    if ((row.correctAnswer ?? '').toUpperCase() !== want) {
      wrongAnswer.push({ number, paper: want, stored: row.correctAnswer })
    }

    
    
    
    if (!labels.includes(want)) noOptions.push(number)
    else if (labels.length < optionCount) shortOptions.push(number)
  }

  return {
    missing,
    phantom,
    duplicated,
    wrongAnswer,
    noOptions,
    shortOptions,
    onAnswerPages: stored.rowsOnAnswerPages,
    blame,
  }
}

function report(paper: Paper, stored: Stored, diff: Diff, verbose: boolean): boolean {
  const expected = paper.key.size
  const problems =
    diff.missing.length +
    diff.phantom.length +
    diff.duplicated.length +
    diff.wrongAnswer.length +
    diff.noOptions.length +
    diff.shortOptions.length +
    diff.onAnswerPages

  const headline = problems === 0 ? 'ok  ' : 'FAIL'
  console.log(
    `${headline} ${paper.name.padEnd(30)} ` +
      `${stored.rows.length}/${expected} stored, ${paper.pages.length} page(s)`,
  )

  if (problems === 0) return true

  const say = (label: string, numbers: number[]) => {
    if (numbers.length === 0) return
    const shown = verbose || numbers.length <= 12 ? numbers.join(', ') : `${numbers.length} of them`
    console.log(`       ${label}: ${shown}`)
  }

  if (diff.missing.length > 0) {
    const pages = [...new Set(diff.missing.map((n) => diff.blame.get(n)).filter(Boolean))]
    say('never stored', diff.missing)
    if (pages.length > 0) console.log(`       the paper prints them on page(s) ${pages.join(', ')}`)
  }

  say('numbers the paper does not have', diff.phantom)
  say('numbers stored twice', diff.duplicated)
  say('cannot offer the answer the paper names', diff.noOptions)
  say('short of options, though it has the right one', diff.shortOptions)

  if (diff.wrongAnswer.length > 0) {
    const shown = verbose ? diff.wrongAnswer : diff.wrongAnswer.slice(0, 6)
    for (const wrong of shown) {
      console.log(
        `       answer for ${wrong.number}: paper says ${wrong.paper}, ` +
          `stored ${wrong.stored ?? 'nothing'}`,
      )
    }
    if (!verbose && diff.wrongAnswer.length > shown.length) {
      console.log(`       and ${diff.wrongAnswer.length - shown.length} more`)
    }
  }

  if (diff.onAnswerPages > 0) {
    console.log(
      `       ${diff.onAnswerPages} row(s) stored off answer key or solutions ` +
        `page(s) ${stored.answerPages.join(', ')}`,
    )
  }

  return false
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set.')

  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const verbose = process.argv.includes('--verbose')
  const dir = args[0] ?? join(homedir(), 'Downloads')

  const files = (await readdir(dir))
    .filter((file) => file.toLowerCase().endsWith('.pdf'))
    .sort()

  if (files.length === 0) {
    console.log(`No PDFs in ${dir}.`)
    return
  }

  const sql = connect(url)
  const db = drizzle(sql) as unknown as Db

  const titles = new Set(
    (await db.select({ title: worksheets.title }).from(worksheets)).map((row) => row.title),
  )

  console.log(`Reading ${files.length} PDF(s) from ${dir}\n`)

  let checked = 0
  let clean = 0
  const skipped: string[] = []

  for (const file of files) {
    const name = basename(file, '.pdf')
    const title = ALIASES[name] ?? name

    if (!titles.has(title)) continue

    const paper = await readPaper(join(dir, file))

    if (paper.key.size === 0) {
      skipped.push(`${name}: no answer key found in the PDF, nothing to check against`)
      continue
    }

    const stored = await readStored(db, title)
    if (!stored) continue

    checked += 1
    if (report(paper, stored, compare(paper, stored), verbose)) clean += 1
  }

  for (const note of skipped) console.log(`skip ${note}`)

  console.log(`\n${clean}/${checked} sheet(s) match the paper they came from.`)

  await sql.end()
  process.exit(clean === checked ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
