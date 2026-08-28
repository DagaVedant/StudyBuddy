import assert from 'node:assert/strict'
import test from 'node:test'

import {countExportableQuestions, getMissedQuestions} from '@/lib/blooket'
import {type Db} from '@/lib/db'
import {answerChoices, attempts, questions} from '@/lib/schema'

import {freshDb, makeUser, makeWorksheet, uid} from './support/db'

let ordinal = 0

type Choice = {
  label: string
  text: string
  isCorrect?: boolean
}

async function missedQuestion(
  db: Db,
  userId: string,
  worksheetId: string,
  {choices = [], correctAnswer = null}: {choices?: Choice[]; correctAnswer?: string | null},
) {
  const id = uid('q')
  await db.insert(questions).values({
    id,
    userId,
    worksheetId,
    ordinal: (ordinal += 1),
    promptText: 'If 3x + 7 = 25, what is the value of x?',
    questionType: 'multiple_choice',
    origin: 'extracted',
    correctAnswer,
  })
  for (const choice of choices) {
    await db.insert(answerChoices).values({
      id: uid('choice'),
      questionId: id,
      label: choice.label,
      text: choice.text,
      isCorrect: choice.isCorrect === true,
    })
  }
  await db.insert(attempts).values({
    id: uid('attempt'),
    userId,
    questionId: id,
    outcome: 'wrong',
    source: 'markup',
  })
  return id
}

test('a missed question with no answer key is not offered for export', async () => {
  const db = await freshDb()
  const userId = await makeUser(db)
  const worksheetId = await makeWorksheet(db, userId)

  await missedQuestion(db, userId, worksheetId, {
    choices: [
      {label: 'A', text: '13'},
      {label: 'B', text: '6'},
    ],
  })

  assert.equal(await countExportableQuestions(db, userId), 0)
})

test('a marked choice and a typed answer each make a missed question exportable', async () => {
  const db = await freshDb()
  const userId = await makeUser(db)
  const worksheetId = await makeWorksheet(db, userId)

  await missedQuestion(db, userId, worksheetId, {
    choices: [
      {label: 'A', text: '13'},
      {label: 'B', text: '6', isCorrect: true},
    ],
  })
  await missedQuestion(db, userId, worksheetId, {correctAnswer: '6'})

  assert.equal(await countExportableQuestions(db, userId), 2)
})

test('the count never promises more than the export can build', async () => {
  const db = await freshDb()
  const userId = await makeUser(db)
  const worksheetId = await makeWorksheet(db, userId)

  await missedQuestion(db, userId, worksheetId, {
    choices: [{label: 'A', text: '13'}, {label: 'B', text: '6'}],
  })
  await missedQuestion(db, userId, worksheetId, {correctAnswer: '   '})
  await missedQuestion(db, userId, worksheetId, {
    choices: [{label: 'A', text: '6', isCorrect: true}],
  })
  await missedQuestion(db, userId, worksheetId, {
    choices: [{label: 'A', text: '13'}, {label: 'B', text: '6', isCorrect: true}],
  })

  const missed = await getMissedQuestions(db, userId)

  let buildable = 0

  for (const question of missed) {
    let typed = ''
    if (question.correctAnswer) typed = question.correctAnswer.trim()

    if (typed !== '') {
      buildable = buildable + 1
      continue
    }

    let usable = 0
    let anyCorrect = false

    for (const choice of question.choices) {
      if (choice.text.trim()) usable = usable + 1
      if (choice.isCorrect) anyCorrect = true
    }

    if (usable >= 2 && anyCorrect) buildable = buildable + 1
  }

  assert.equal(await countExportableQuestions(db, userId), buildable)
  assert.equal(buildable, 1)
})
