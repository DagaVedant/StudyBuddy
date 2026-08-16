import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { applyClassification, shortlistByVector } from '@/lib/classify'
import { pendingQuestions } from '@/lib/classify/pending'
import { questionTopics, topicProposals, topics } from '@/lib/db/schema'
import { EMBEDDING_DIMENSIONS } from '@/lib/embeddings'
import type { TopicCandidate } from '@/lib/ai/types'

import { asDb, createTestDb, type TestDb } from '../helpers/db'
import { makeQuestion, makeUser, makeWorksheet, seedTaxonomy } from '../helpers/factories'

let db: TestDb
let close: () => Promise<void>

beforeAll(async () => {
  const created = await createTestDb()
  db = created.db
  close = created.close
  await seedTaxonomy(db)
})

afterAll(async () => {
  await close()
})

const client = () => asDb(db)

const CANDIDATES: TopicCandidate[] = [
  {
    slug: 'high-school-math.geometry.circles.central-and-inscribed-angles',
    name: 'Central and inscribed angles',
    path: 'High School Math › Geometry › Circles › Central and inscribed angles',
  },
  {
    slug: 'high-school-math.geometry.circles.arcs-and-chords',
    name: 'Arcs and chords',
    path: 'High School Math › Geometry › Circles › Arcs and chords',
  },
]

async function question() {
  const userId = await makeUser(db)
  const worksheetId = await makeWorksheet(db, userId)
  const { id } = await makeQuestion(db, userId, worksheetId, {
    promptText: 'In how many ways can 6 people be seated around a circular table?',
  })

  return { id, promptText: 'In how many ways can 6 people be seated around a circular table?', userId }
}

const tagsOf = (questionId: string) =>
  db.select().from(questionTopics).where(eq(questionTopics.questionId, questionId))

describe('applyClassification', () => {
  it('tags the leaf the model picked', async () => {
    const q = await question()

    const outcome = await applyClassification(client(), q, CANDIDATES, {
      topic_slug: CANDIDATES[0].slug,
      confidence: 0.8,
      abstain: false,
      suggested_name: null,
    })

    const [topic] = await db
      .select({ id: topics.id })
      .from(topics)
      .where(eq(topics.slug, CANDIDATES[0].slug))

    expect(outcome.topicId).toBe(topic.id)
    expect(outcome.coarse).toBe(false)
    expect((await tagsOf(q.id))[0].topicId).toBe(topic.id)
  })

  /**
   * The abstain path is what the classify prompt asks the model to use, in as
   * many words: a wrong-but-plausible tag is worse than none, because it
   * corrupts the weakness report and nobody can see that it happened. The
   * pipeline used to answer an abstain by tagging the question with the parent
   * of the nearest embedding match, which is the branch the model had been shown
   * and declined. Nineteen questions in the Edison run were tagged that way,
   * several at confidence 1.00.
   */
  it('leaves the question untagged when the model abstains', async () => {
    const q = await question()

    const outcome = await applyClassification(client(), q, CANDIDATES, {
      topic_slug: null,
      confidence: 0.9,
      abstain: true,
      suggested_name: 'Circular permutations',
    })

    expect(outcome.topicId).toBeNull()
    expect(outcome.coarse).toBe(true)
    expect(await tagsOf(q.id)).toEqual([])
  })

  it('still raises a proposal, which is the visible part of an abstain', async () => {
    const q = await question()

    const outcome = await applyClassification(client(), q, CANDIDATES, {
      topic_slug: null,
      confidence: 0.9,
      abstain: true,
      suggested_name: 'Circular permutations',
    })

    expect(outcome.proposalId).not.toBeNull()

    const [proposal] = await db
      .select()
      .from(topicProposals)
      .where(eq(topicProposals.id, outcome.proposalId!))

    expect(proposal.proposedName).toBe('Circular permutations')
    expect(proposal.status).toBe('pending')
    // Somewhere to hang it, which is the only thing the nearest ancestor is
    // still used for.
    expect(proposal.suggestedParentId).not.toBeNull()
  })

  it('leaves the question untagged when the model invents a slug', async () => {
    const q = await question()

    const outcome = await applyClassification(client(), q, CANDIDATES, {
      topic_slug: 'high-school-math.geometry.circles.made-this-up',
      confidence: 1,
      abstain: false,
      suggested_name: null,
    })

    expect(outcome.topicId).toBeNull()
    expect(await tagsOf(q.id)).toEqual([])
  })

  /**
   * `CONFIDENCE_FLOOR` was 0.45 and nothing in 288 questions came back below
   * 0.75, so the threshold never once fired. A number a 7B model writes about
   * its own work is not evidence; it is stored and not acted on.
   */
  it('tags on a low confidence, because the number is not calibrated', async () => {
    const q = await question()

    const outcome = await applyClassification(client(), q, CANDIDATES, {
      topic_slug: CANDIDATES[1].slug,
      confidence: 0.2,
      abstain: false,
      suggested_name: null,
    })

    expect(outcome.topicId).not.toBeNull()
    expect((await tagsOf(q.id))[0].confidence).toBeCloseTo(0.2)
  })

  it('does nothing at all when the shortlist came back empty', async () => {
    const q = await question()

    const outcome = await applyClassification(client(), q, [], {
      topic_slug: null,
      confidence: 0,
      abstain: true,
      suggested_name: null,
    })

    expect(outcome).toEqual({ topicId: null, coarse: false, proposalId: null, confidence: 0 })
    expect(await tagsOf(q.id)).toEqual([])
  })
})

/**
 * The one control a student has over how their questions get sorted.
 *
 * The upload form offers a subject root and every one of its children, and the
 * filter kept only the first dotted segment, so every child collapsed back to
 * its root: choosing Algebra 1 searched the whole of High School Math.
 */
describe('the subject hint', () => {
  const ALGEBRA = 'high-school-math.algebra-1.foundations.order-of-operations'
  const GEOMETRY = 'high-school-math.geometry.foundations.points-lines-and-planes'

  // The same vector on both, so nothing but the filter can separate them, and
  // every other seeded topic has a null embedding so none of them qualify.
  beforeAll(async () => {
    const vector = new Array(EMBEDDING_DIMENSIONS).fill(0)
    vector[3] = 1

    await db
      .update(topics)
      .set({ embedding: vector })
      .where(inArray(topics.slug, [ALGEBRA, GEOMETRY]))
  })

  const shortlist = async (subjectHint?: string | null) => {
    const vector = new Array(EMBEDDING_DIMENSIONS).fill(0)
    vector[3] = 1

    return (await shortlistByVector(client(), vector, { subjectHint, limit: 25 })).map(
      (candidate) => candidate.slug,
    )
  }

  it('keeps the sub-subject the student actually chose', async () => {
    const slugs = await shortlist('high-school-math.algebra-1')

    expect(slugs).toContain(ALGEBRA)
    expect(slugs).not.toContain(GEOMETRY)
  })

  it('still takes a whole subject when that is what was chosen', async () => {
    const slugs = await shortlist('high-school-math')

    expect(slugs).toContain(ALGEBRA)
    expect(slugs).toContain(GEOMETRY)
  })

  it('searches everything when no hint was given', async () => {
    const slugs = await shortlist(null)

    expect(slugs).toContain(ALGEBRA)
    expect(slugs).toContain(GEOMETRY)
  })

  /**
   * `subjectHint` is a free string on the worksheet route, so this is reachable
   * without going near the form. Filtering on it would leave no candidates,
   * which is indistinguishable from a question nothing matched, and the whole
   * paper would come back untagged with nothing anywhere saying why.
   */
  it('ignores a hint that names no topic rather than matching nothing', async () => {
    const slugs = await shortlist('high-school-mat')

    expect(slugs).toContain(ALGEBRA)
    expect(slugs).toContain(GEOMETRY)
  })

  it('does not treat a wildcard in the hint as a wildcard', async () => {
    expect(await shortlist('high-school-math.%')).toEqual(
      expect.arrayContaining([ALGEBRA, GEOMETRY]),
    )
  })

  it('honours a hint for a different subject, even though it leaves nothing', async () => {
    expect(await shortlist('sat-math')).toEqual([])
  })
})

describe('pendingQuestions', () => {
  async function paper(count: number) {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    const ids: string[] = []
    for (let ordinal = 1; ordinal <= count; ordinal += 1) {
      const { id } = await makeQuestion(db, userId, worksheetId, {
        ordinal,
        promptText: `Question ${ordinal}`,
      })
      ids.push(id)
    }

    return { userId, worksheetId, ids }
  }

  const tag = async (questionId: string) => {
    const [topic] = await db
      .select({ id: topics.id })
      .from(topics)
      .where(eq(topics.slug, CANDIDATES[0].slug))

    await db.insert(questionTopics).values({
      questionId,
      topicId: topic.id,
      confidence: 1,
      assignedBy: 'ai',
      isPrimary: true,
    })
  }

  it('hands them over in the order the paper prints them', async () => {
    const { worksheetId } = await paper(6)

    const pending = await pendingQuestions(client(), worksheetId)

    expect(pending.map((row) => row.promptText)).toEqual([
      'Question 1',
      'Question 2',
      'Question 3',
      'Question 4',
      'Question 5',
      'Question 6',
    ])
  })

  it('leaves out the ones that already have a topic', async () => {
    const { worksheetId, ids } = await paper(4)
    await tag(ids[1])

    const pending = await pendingQuestions(client(), worksheetId)

    expect(pending.map((row) => row.id)).toEqual([ids[0], ids[2], ids[3]])
  })

  /**
   * The resume case, and the one that lost questions outright. The cap used to
   * apply before the tagged ones were removed, so a paper whose first page was
   * already classified handed back an empty list, which reads as "nothing left
   * to do" while the rest of the paper had never been looked at.
   */
  it('spends the page on work, not on questions already done', async () => {
    const { worksheetId, ids } = await paper(5)
    for (const id of ids.slice(0, 3)) await tag(id)

    const pending = await pendingQuestions(client(), worksheetId, 3)

    expect(pending.map((row) => row.id)).toEqual([ids[3], ids[4]])
  })

  it('never hands back more than a page', async () => {
    const { worksheetId, ids } = await paper(5)

    const pending = await pendingQuestions(client(), worksheetId, 2)

    expect(pending.map((row) => row.id)).toEqual([ids[0], ids[1]])
  })
})
