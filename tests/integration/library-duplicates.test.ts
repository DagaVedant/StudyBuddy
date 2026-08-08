import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { EMBEDDING_DIMENSIONS } from '@/lib/embeddings'
import { findLibraryDuplicates } from '@/lib/questions/library-duplicates'

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

/**
 * A unit vector pointing `angle` radians off the first axis, padded out to the
 * model's width. Two of these are as similar as their angles are close, which
 * makes the threshold testable without loading MiniLM.
 */
function vector(angle: number): number[] {
  const values = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
  values[0] = Math.cos(angle)
  values[1] = Math.sin(angle)
  return values
}

describe('findLibraryDuplicates', () => {
  it('finds the same question on an earlier worksheet by content hash', async () => {
    const userId = await makeUser(db)
    const older = await makeWorksheet(db, userId, 'Algebra Book 1')
    const newer = await makeWorksheet(db, userId, 'Algebra Book 2')

    await makeQuestion(db, userId, older, { promptText: 'Solve 2x=8', contentHash: 'h1' })
    const { id } = await makeQuestion(db, userId, newer, {
      promptText: 'Solve 2x=8',
      contentHash: 'h1',
    })

    const found = await findLibraryDuplicates(client(), userId, newer)

    expect(found).toHaveLength(1)
    expect(found[0].questionId).toBe(id)
    expect(found[0].exact).toBe(true)
    expect(found[0].matchWorksheetTitle).toBe('Algebra Book 1')
  })

  it('does not report a question against others on its own worksheet', async () => {
    const userId = await makeUser(db)
    const sheet = await makeWorksheet(db, userId)

    await makeQuestion(db, userId, sheet, { ordinal: 1, contentHash: 'same' })
    await makeQuestion(db, userId, sheet, { ordinal: 2, contentHash: 'same' })

    expect(await findLibraryDuplicates(client(), userId, sheet)).toEqual([])
  })

  it('does not cross accounts', async () => {
    const mine = await makeUser(db)
    const theirs = await makeUser(db)

    const theirSheet = await makeWorksheet(db, theirs, 'Their Book')
    await makeQuestion(db, theirs, theirSheet, { contentHash: 'shared' })

    const mySheet = await makeWorksheet(db, mine, 'My Book')
    await makeQuestion(db, mine, mySheet, { contentHash: 'shared' })

    expect(await findLibraryDuplicates(client(), mine, mySheet)).toEqual([])
  })

  it('catches a near match the hash misses', async () => {
    const userId = await makeUser(db)
    const older = await makeWorksheet(db, userId, 'Geometry Set A')
    const newer = await makeWorksheet(db, userId, 'Geometry Set B')

    await makeQuestion(db, userId, older, {
      promptText: 'Find angle C.',
      contentHash: 'old-hash',
      embedding: vector(0),
    })

    const { id } = await makeQuestion(db, userId, newer, {
      // The reader mangled a symbol, so the hashes differ and the vectors
      // barely move. This is the case the embedding half exists for.
      promptText: 'Find angle C .',
      contentHash: 'new-hash',
      embedding: vector(0.05),
    })

    const found = await findLibraryDuplicates(client(), userId, newer)

    expect(found).toHaveLength(1)
    expect(found[0].questionId).toBe(id)
    expect(found[0].exact).toBe(false)
  })

  it('leaves merely related questions alone', async () => {
    const userId = await makeUser(db)
    const older = await makeWorksheet(db, userId, 'Set A')
    const newer = await makeWorksheet(db, userId, 'Set B')

    await makeQuestion(db, userId, older, {
      promptText: 'Find angle C.',
      contentHash: 'a',
      embedding: vector(0),
    })
    await makeQuestion(db, userId, newer, {
      promptText: 'Find angle B.',
      contentHash: 'b',
      embedding: vector(0.9),
    })

    expect(await findLibraryDuplicates(client(), userId, newer)).toEqual([])
  })

  it('reports an exact match as exact even when the vectors also agree', async () => {
    const userId = await makeUser(db)
    const older = await makeWorksheet(db, userId, 'Set A')
    const newer = await makeWorksheet(db, userId, 'Set B')

    await makeQuestion(db, userId, older, { contentHash: 'h', embedding: vector(0) })
    await makeQuestion(db, userId, newer, { contentHash: 'h', embedding: vector(0) })

    const found = await findLibraryDuplicates(client(), userId, newer)

    expect(found).toHaveLength(1)
    expect(found[0].exact).toBe(true)
  })

  it('says nothing about a worksheet with no questions', async () => {
    const userId = await makeUser(db)
    const empty = await makeWorksheet(db, userId)

    expect(await findLibraryDuplicates(client(), userId, empty)).toEqual([])
  })
})
