import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { explanations, reports } from '@/lib/db/schema'
import { recordReport } from '@/lib/reports'

import { asDb, createTestDb, type TestDb } from '../helpers/db'
import { makeQuestion, makeUser, makeWorksheet } from '../helpers/factories'

let db: TestDb
let close: () => Promise<void>

beforeAll(async () => {
  const created = await createTestDb()
  db = created.db
  close = created.close
})

afterAll(async () => {
  await close()
})

const client = () => asDb(db)

async function explain(questionId: string, body: string, generatedAt?: Date) {
  const [row] = await db
    .insert(explanations)
    .values({
      questionId,
      bodyMd: body,
      ...(generatedAt ? { generatedAt } : {}),
    })
    .returning({ id: explanations.id })
  return row.id
}

describe('recordReport', () => {
  it('records a report against a whole worksheet', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    const outcome = await recordReport(client(), userId, {
      kind: 'worksheet',
      worksheetId,
      message: 'It missed the whole of page 4.',
    })

    expect(outcome.ok).toBe(true)

    const [row] = await db.select().from(reports).where(eq(reports.worksheetId, worksheetId))
    expect(row.kind).toBe('worksheet')
    expect(row.message).toBe('It missed the whole of page 4.')
    expect(row.questionId).toBeNull()
    expect(row.resolvedAt).toBeNull()
  })

  it('keeps a report with no note', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    await recordReport(client(), userId, { kind: 'worksheet', worksheetId, message: '   ' })

    const [row] = await db.select().from(reports).where(eq(reports.worksheetId, worksheetId))
    expect(row.message).toBeNull()
  })

  it('refuses a worksheet belonging to someone else', async () => {
    const mine = await makeUser(db)
    const theirs = await makeUser(db)
    const worksheetId = await makeWorksheet(db, theirs)

    const outcome = await recordReport(client(), mine, { kind: 'worksheet', worksheetId })

    expect(outcome).toEqual({ ok: false, reason: 'not_found' })
    expect(await db.select().from(reports).where(eq(reports.worksheetId, worksheetId))).toEqual(
      [],
    )
  })

  it('marks the explanation wrong so the next ask regenerates it', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const question = await makeQuestion(db, userId, worksheetId)
    const explanationId = await explain(question.id, 'Because the angles are equal.')

    const outcome = await recordReport(client(), userId, {
      kind: 'explanation',
      questionId: question.id,
      message: 'That is the wrong theorem.',
    })

    expect(outcome.ok).toBe(true)

    const [row] = await db
      .select()
      .from(explanations)
      .where(eq(explanations.id, explanationId))
    expect(row.reportedWrong).toBe(true)

    const [report] = await db
      .select()
      .from(reports)
      .where(eq(reports.questionId, question.id))
    expect(report.explanationId).toBe(explanationId)
    // Carried across so the admin page can group a question's report under the
    // worksheet it came from without a second join.
    expect(report.worksheetId).toBe(worksheetId)
  })

  it('marks the newest explanation, not the first', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const question = await makeQuestion(db, userId, worksheetId)

    const older = await explain(question.id, 'First try.', new Date('2026-01-01T00:00:00Z'))
    const newer = await explain(question.id, 'Second try.', new Date('2026-06-01T00:00:00Z'))

    await recordReport(client(), userId, { kind: 'explanation', questionId: question.id })

    const rows = await db
      .select()
      .from(explanations)
      .where(eq(explanations.questionId, question.id))

    expect(rows.find((row) => row.id === newer)?.reportedWrong).toBe(true)
    expect(rows.find((row) => row.id === older)?.reportedWrong).toBe(false)
  })

  it('says so when there is no explanation to report', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const question = await makeQuestion(db, userId, worksheetId)

    expect(
      await recordReport(client(), userId, {
        kind: 'explanation',
        questionId: question.id,
      }),
    ).toEqual({ ok: false, reason: 'nothing_to_report' })
  })

  it('refuses a question belonging to someone else', async () => {
    const mine = await makeUser(db)
    const theirs = await makeUser(db)
    const worksheetId = await makeWorksheet(db, theirs)
    const question = await makeQuestion(db, theirs, worksheetId)
    await explain(question.id, 'Theirs.')

    expect(
      await recordReport(client(), mine, { kind: 'explanation', questionId: question.id }),
    ).toEqual({ ok: false, reason: 'not_found' })
  })
})
