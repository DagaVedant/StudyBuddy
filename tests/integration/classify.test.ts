import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { applyClassification } from '@/lib/classify'
import { questionTopics, topicProposals, topics } from '@/lib/db/schema'
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
   * of the nearest embedding match — the branch the model had just been shown
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
