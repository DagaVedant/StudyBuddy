import {strict as assert} from 'node:assert'
import test from 'node:test'

import {getOverview, getTopicStats} from '@/lib/dashboard'
import {type Db} from '@/lib/db'
import {attempts, questionTopics, questions, topics} from '@/lib/schema'

import {freshDb, makeUser, makeWorksheet, uid} from './support/db'

async function topic(db: Db, name: string) {
  const id = uid('topic')
  await db.insert(topics).values({
    id,
    slug: id,
    name,
    subjectRoot: 'sat-math',
    isLeaf: true,
  })
  return id
}

let ordinal = 0

// one extracted question, answered once, filed under every topic given
async function answeredQuestion(db: Db, userId: string, worksheetId: string, topicIds: string[]) {
  const id = uid('q')
  await db.insert(questions).values({
    id,
    userId,
    worksheetId,
    ordinal: (ordinal += 1),
    promptText: 'If 3x + 7 = 25, what is the value of x?',
    questionType: 'multiple_choice',
    origin: 'extracted',
  })
  for (const topicId of topicIds) {
    await db.insert(questionTopics).values({questionId: id, topicId, assignedBy: 'ai'})
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

test('a question filed under two topics is still one attempt', async () => {
  const db = await freshDb()
  const userId = await makeUser(db)
  const worksheetId = await makeWorksheet(db, userId)

  const algebra = await topic(db, 'Linear equations')
  const wordProblems = await topic(db, 'Word problems')
  await answeredQuestion(db, userId, worksheetId, [algebra, wordProblems])

  // The join to question_topics has two matching rows for this question. If it
  // fans out, every total below doubles and nothing errors.
  const overview = await getOverview(db, userId)
  assert.equal(overview.attemptsLogged, 1)
  assert.equal(overview.questionsTracked, 1)

  const stats = await getTopicStats(db, userId)
  assert.equal(stats.length, 2)
  for (const row of stats) {
    assert.equal(row.correct + row.unsure + row.wrong, 1, `${row.topicName} counted twice`)
  }
})

test('totals track the questions actually answered', async () => {
  const db = await freshDb()
  const userId = await makeUser(db)
  const worksheetId = await makeWorksheet(db, userId)
  const algebra = await topic(db, 'Linear equations')

  await answeredQuestion(db, userId, worksheetId, [algebra])
  await answeredQuestion(db, userId, worksheetId, [algebra])
  await answeredQuestion(db, userId, worksheetId, [algebra])

  const overview = await getOverview(db, userId)
  assert.equal(overview.attemptsLogged, 3)
  assert.equal(overview.questionsTracked, 3)

  const [stats] = await getTopicStats(db, userId)
  assert.equal(stats.wrong, 3)
})
