import {strict as assert} from 'node:assert'
import test from 'node:test'

import {and, eq} from 'drizzle-orm'

import {countExportableQuestions} from '@/lib/blooket'
import {applyCachedSample, CACHED_SAMPLES, findMatchingSample} from '@/lib/samples'
import {answerChoices, attempts, questions, worksheetPages, worksheets} from '@/lib/schema'

import {freshDb, makeUser, makeWorksheet, uid} from './support/db'

const SAMPLE = CACHED_SAMPLES.find((entry) => entry.pages.length === 1)!

async function uploadSample(
  db: Awaited<ReturnType<typeof freshDb>>,
  userId: string,
): Promise<string> {
  const worksheetId = await makeWorksheet(db, userId)

  await db.insert(worksheetPages).values({
    id: uid('page'),
    worksheetId,
    pageNumber: 1,
    imageKey: `${worksheetId}/1.webp`,
    width: 1000,
    height: 1400,
    ocrText: `${SAMPLE.title} — practice questions`,
  })

  return worksheetId
}

test('the cached sample is free the first time', async () => {
  const db = await freshDb()
  const userId = await makeUser(db)
  const worksheetId = await uploadSample(db, userId)

  const match = await findMatchingSample(db, worksheetId, userId)

  assert.ok(match)
  assert.equal(match.sample.slug, SAMPLE.slug)
})

test('the same sample twice does not keep skipping the trial', async () => {
  const db = await freshDb()
  const userId = await makeUser(db)

  const first = await uploadSample(db, userId)
  assert.ok(await findMatchingSample(db, first, userId), 'the first run was not free')

  // what the completed run records, and what a second attempt has to notice
  await db
    .update(worksheets)
    .set({sampleSlug: SAMPLE.slug})
    .where(eq(worksheets.id, first))

  const second = await uploadSample(db, userId)
  const match = await findMatchingSample(db, second, userId)

  assert.equal(
    match,
    null,
    'the sample matched again, so the trial can be skipped indefinitely',
  )
})

test('one account using a sample does not spend it for everyone', async () => {
  const db = await freshDb()
  const mine = await makeUser(db)
  const theirs = await makeUser(db)

  const used = await uploadSample(db, mine)
  await db
    .update(worksheets)
    .set({sampleSlug: SAMPLE.slug})
    .where(eq(worksheets.id, used))

  const fresh = await uploadSample(db, theirs)

  assert.ok(
    await findMatchingSample(db, fresh, theirs),
    'a different account was charged for someone else using the sample',
  )
})

async function uploadPagesFor(
  db: Awaited<ReturnType<typeof freshDb>>,
  userId: string,
  sample: (typeof CACHED_SAMPLES)[number],
): Promise<{worksheetId: string; pages: {id: string}[]}> {
  const worksheetId = await makeWorksheet(db, userId)
  const pages: {id: string}[] = []

  for (const [index] of sample.pages.entries()) {
    const id = uid('page')
    await db.insert(worksheetPages).values({
      id,
      worksheetId,
      pageNumber: index + 1,
      imageKey: `${worksheetId}/${index + 1}.webp`,
      width: 1000,
      height: 1400,
      ocrText: `${sample.title} page ${index + 1}`,
    })
    pages.push({id})
  }

  return {worksheetId, pages}
}

test('every sample answer names a choice that actually exists', () => {
  for (const sample of CACHED_SAMPLES) {
    const flat = sample.pages.flat()

    assert.equal(
      Object.keys(sample.answers).length,
      flat.length,
      `${sample.slug} keys ${Object.keys(sample.answers).length} of ${flat.length} questions`,
    )

    for (const question of flat) {
      const label = sample.answers[question.ordinal]
      assert.ok(label, `${sample.slug} #${question.ordinal} has no answer`)
      assert.ok(
        question.choices.some((choice) => choice.label === label),
        `${sample.slug} #${question.ordinal} points at choice ${label}, which it does not have`,
      )
    }
  }
})

for (const sample of CACHED_SAMPLES) {
  test(`${sample.slug} lands every answer on the question it belongs to`, async () => {
    const db = await freshDb()
    const userId = await makeUser(db)
    const {worksheetId, pages} = await uploadPagesFor(db, userId, sample)

    const total = await applyCachedSample(db, worksheetId, userId, sample, pages)
    assert.equal(total, sample.pages.flat().length, 'not every question persisted')

    const rows = await db
      .select({
        id: questions.id,
        ordinal: questions.ordinal,
        promptText: questions.promptText,
        correctAnswer: questions.correctAnswer,
        answerSource: questions.answerSource,
      })
      .from(questions)
      .where(eq(questions.worksheetId, worksheetId))

    assert.equal(rows.length, total)

    for (const row of rows) {
      // the ordinal the row landed on has to be the one the key was written for,
      // which is what breaks if persistQuestions ever renumbers
      const source = sample.pages.flat().find((entry) => entry.ordinal === row.ordinal)
      assert.ok(source, `nothing in ${sample.slug} was numbered ${row.ordinal}`)
      assert.equal(row.promptText, source.prompt_text, `#${row.ordinal} is the wrong question`)

      assert.equal(row.correctAnswer, sample.answers[row.ordinal])
      assert.equal(row.answerSource, 'pdf_key')

      const marked = await db
        .select({label: answerChoices.label})
        .from(answerChoices)
        .where(
          and(eq(answerChoices.questionId, row.id), eq(answerChoices.isCorrect, true)),
        )

      assert.equal(marked.length, 1, `#${row.ordinal} has ${marked.length} correct choices`)
      assert.equal(marked[0].label, row.correctAnswer)
    }
  })
}

test('a missed sample question can actually be exported', async () => {
  const db = await freshDb()
  const userId = await makeUser(db)
  const {worksheetId, pages} = await uploadPagesFor(db, userId, SAMPLE)

  await applyCachedSample(db, worksheetId, userId, SAMPLE, pages)

  const rows = await db
    .select({id: questions.id})
    .from(questions)
    .where(eq(questions.worksheetId, worksheetId))

  for (const row of rows) {
    await db.insert(attempts).values({
      id: uid('attempt'),
      userId,
      questionId: row.id,
      outcome: 'wrong',
      source: 'markup',
    })
  }

  assert.equal(await countExportableQuestions(db, userId), rows.length)
})
