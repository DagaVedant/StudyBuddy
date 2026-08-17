import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { shortlistByVector } from '@/lib/classify'
import { acceptTopicProposal, mergeTopicProposal, slugify } from '@/lib/classify/proposals'
import { questionTopics, topicProposals, topics } from '@/lib/db/schema'
import { EMBEDDING_DIMENSIONS } from '@/lib/embeddings'
import { demoteParentsWithChildren } from '@/lib/taxonomy/leaves'

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

async function makeParent(slug: string, isLeaf = true) {
  const [row] = await db
    .insert(topics)
    .values({
      slug,
      name: 'Geometry',
      depth: 1,
      subjectRoot: 'competition-math',
      isCanonical: true,
      isLeaf,
    })
    .returning({ id: topics.id })

  return row.id
}

async function makeProposal(over: {
  proposedName: string
  suggestedParentId?: string | null
  sourceQuestionId?: string | null
  status?: 'pending' | 'accepted'
  embedding?: number[] | null
}) {
  const [row] = await db
    .insert(topicProposals)
    .values({
      proposedName: over.proposedName,
      suggestedParentId: over.suggestedParentId ?? null,
      sourceQuestionId: over.sourceQuestionId ?? null,
      status: over.status ?? 'pending',
      embedding: over.embedding ?? null,
    })
    .returning({ id: topicProposals.id })

  return row.id
}

function axis(index: number): number[] {
  const vector = new Array(EMBEDDING_DIMENSIONS).fill(0)
  vector[index] = 1
  return vector
}

describe('losing the race for a slug', () => {
  it('retries when someone takes the slug mid-transaction', async () => {
    const parentId = await makeParent('competition-math.vectors')
    const proposalId = await makeProposal({
      proposedName: 'Dot product',
      suggestedParentId: parentId,
    })

    let failures = 1
    const flaky = new Proxy(client(), {
      get(target, property, receiver) {
        if (property === 'transaction' && failures > 0) {
          failures -= 1
          return async () => {
            throw Object.assign(new Error('duplicate key value'), { code: '23505' })
          }
        }

        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })

    const accepted = await acceptTopicProposal(flaky, proposalId)

    if (!accepted.ok) throw new Error(`expected acceptance, got ${accepted.reason}`)
    expect(accepted.slug).toBe('competition-math.vectors.dot-product')
    expect(failures).toBe(0)
  })

  it('gives up rather than looping when the collision never clears', async () => {
    const parentId = await makeParent('competition-math.matrices')
    const proposalId = await makeProposal({
      proposedName: 'Determinants',
      suggestedParentId: parentId,
    })

    let attempts = 0
    const stuck = new Proxy(client(), {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return async () => {
            attempts += 1
            throw Object.assign(new Error('duplicate key value'), { code: '23505' })
          }
        }

        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })

    await expect(acceptTopicProposal(stuck, proposalId)).rejects.toThrow(/duplicate key/)
    expect(attempts).toBe(3)
  })

  it('does not swallow a failure that is not a collision', async () => {
    const parentId = await makeParent('competition-math.complex-numbers')
    const proposalId = await makeProposal({
      proposedName: 'Argand diagrams',
      suggestedParentId: parentId,
    })

    let attempts = 0
    const broken = new Proxy(client(), {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return async () => {
            attempts += 1
            throw Object.assign(new Error('connection terminated'), { code: '08006' })
          }
        }

        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })

    await expect(acceptTopicProposal(broken, proposalId)).rejects.toThrow(
      /connection terminated/,
    )
    expect(attempts).toBe(1)
  })
})

describe('acceptTopicProposal', () => {
  it('adds the topic under its suggested parent', async () => {
    const parentId = await makeParent('competition-math.geometry')
    const proposalId = await makeProposal({
      proposedName: 'Circle theorems',
      suggestedParentId: parentId,
    })

    const outcome = await acceptTopicProposal(client(), proposalId)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    const [created] = await db.select().from(topics).where(eq(topics.id, outcome.topicId))

    expect(created.slug).toBe('competition-math.geometry.circle-theorems')
    expect(created.name).toBe('Circle theorems')
    expect(created.parentId).toBe(parentId)
    expect(created.depth).toBe(2)
    expect(created.subjectRoot).toBe('competition-math')
    expect(created.isLeaf).toBe(true)
    // It did not come from the seeded taxonomy, and a re-seed needs to know.
    expect(created.isCanonical).toBe(false)
  })

  it('records the proposal as accepted and points it at the new topic', async () => {
    const parentId = await makeParent('competition-math.algebra')
    const proposalId = await makeProposal({
      proposedName: 'Rational exponents',
      suggestedParentId: parentId,
    })

    const outcome = await acceptTopicProposal(client(), proposalId)
    if (!outcome.ok) throw new Error('expected acceptance')

    const [after] = await db
      .select()
      .from(topicProposals)
      .where(eq(topicProposals.id, proposalId))

    expect(after.status).toBe('accepted')
    expect(after.mergedIntoTopicId).toBe(outcome.topicId)
  })

  it('stops the parent being a leaf, since questions cannot land on it now', async () => {
    const parentId = await makeParent('competition-math.stats', true)
    const proposalId = await makeProposal({
      proposedName: 'Box plots',
      suggestedParentId: parentId,
    })

    await acceptTopicProposal(client(), proposalId)

    const [parent] = await db.select().from(topics).where(eq(topics.id, parentId))
    expect(parent.isLeaf).toBe(false)
  })

  it('tags the question that raised it', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const question = await makeQuestion(db, userId, worksheetId)

    const parentId = await makeParent('competition-math.arithmetic-and-number-sense')
    const proposalId = await makeProposal({
      proposedName: 'Scientific notation',
      suggestedParentId: parentId,
      sourceQuestionId: question.id,
    })

    const outcome = await acceptTopicProposal(client(), proposalId)
    if (!outcome.ok) throw new Error('expected acceptance')

    expect(outcome.taggedSource).toBe(true)

    const [tag] = await db
      .select()
      .from(questionTopics)
      .where(eq(questionTopics.questionId, question.id))

    expect(tag.topicId).toBe(outcome.topicId)
    expect(tag.assignedBy).toBe('user')
    expect(tag.isPrimary).toBe(true)
  })

  it('refuses a proposal with nowhere to hang it', async () => {
    const proposalId = await makeProposal({ proposedName: 'Orphan', suggestedParentId: null })

    const outcome = await acceptTopicProposal(client(), proposalId)

    expect(outcome).toEqual({ ok: false, reason: 'no_parent' })
    const [after] = await db
      .select()
      .from(topicProposals)
      .where(eq(topicProposals.id, proposalId))
    expect(after.status).toBe('pending')
  })

  it('refuses to accept the same proposal twice', async () => {
    const parentId = await makeParent('competition-math.trig')
    const proposalId = await makeProposal({
      proposedName: 'Unit circle',
      suggestedParentId: parentId,
    })

    expect((await acceptTopicProposal(client(), proposalId)).ok).toBe(true)

    const second = await acceptTopicProposal(client(), proposalId)
    expect(second).toEqual({ ok: false, reason: 'not_pending' })
  })

  it('does not collide when two proposals share a name under one parent', async () => {
    const parentId = await makeParent('competition-math.functions')

    const first = await acceptTopicProposal(
      client(),
      await makeProposal({ proposedName: 'Inverses', suggestedParentId: parentId }),
    )
    const second = await acceptTopicProposal(
      client(),
      await makeProposal({ proposedName: 'Inverses', suggestedParentId: parentId }),
    )

    if (!first.ok || !second.ok) throw new Error('expected both to be accepted')
    expect(first.slug).toBe('competition-math.functions.inverses')
    expect(second.slug).toBe('competition-math.functions.inverses-2')
  })

  it('reports a proposal that is not there', async () => {
    expect(await acceptTopicProposal(client(), 'nope')).toEqual({
      ok: false,
      reason: 'not_found',
    })
  })
})

/*
 * Finding 118 / §7.2's other resolution: the tree already has a leaf for
 * this, the classifier's shortlist just did not surface it. Unlike accept,
 * merge must not grow the tree at all.
 */
describe('mergeTopicProposal', () => {
  it('tags the source question against the chosen leaf, not a new topic', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const question = await makeQuestion(db, userId, worksheetId)

    const target = await makeParent('competition-math.geometry.circles')
    const proposalId = await makeProposal({
      proposedName: 'Circles',
      sourceQuestionId: question.id,
    })

    const outcome = await mergeTopicProposal(client(), proposalId, target)

    expect(outcome).toEqual({ ok: true, taggedSource: true })

    const [tag] = await db
      .select()
      .from(questionTopics)
      .where(eq(questionTopics.questionId, question.id))

    expect(tag.topicId).toBe(target)
    expect(tag.assignedBy).toBe('user')
    expect(tag.isPrimary).toBe(true)
  })

  it('records the proposal as merged and points it at the existing topic', async () => {
    const target = await makeParent('competition-math.geometry.triangles')
    const proposalId = await makeProposal({ proposedName: 'Triangles' })

    await mergeTopicProposal(client(), proposalId, target)

    const [after] = await db
      .select()
      .from(topicProposals)
      .where(eq(topicProposals.id, proposalId))

    expect(after.status).toBe('merged')
    expect(after.mergedIntoTopicId).toBe(target)
  })

  it('does not create a topic, unlike accept', async () => {
    const target = await makeParent('competition-math.geometry.polygons')
    const proposalId = await makeProposal({ proposedName: 'Polygons' })

    const before = (await db.select().from(topics)).length
    await mergeTopicProposal(client(), proposalId, target)
    const after = (await db.select().from(topics)).length

    expect(after).toBe(before)
  })

  it('refuses a target that is not a leaf', async () => {
    const target = await makeParent('competition-math.geometry.shelf', false)
    const proposalId = await makeProposal({ proposedName: 'Shelf child' })

    const outcome = await mergeTopicProposal(client(), proposalId, target)

    expect(outcome).toEqual({ ok: false, reason: 'target_not_leaf' })
    const [after] = await db
      .select()
      .from(topicProposals)
      .where(eq(topicProposals.id, proposalId))
    expect(after.status).toBe('pending')
  })

  it('refuses a target that does not exist', async () => {
    const proposalId = await makeProposal({ proposedName: 'Nowhere' })

    expect(await mergeTopicProposal(client(), proposalId, 'nope')).toEqual({
      ok: false,
      reason: 'target_not_found',
    })
  })

  it('refuses a proposal that is not pending', async () => {
    const target = await makeParent('competition-math.geometry.quadrilaterals')
    const proposalId = await makeProposal({ proposedName: 'Quads' })

    expect((await mergeTopicProposal(client(), proposalId, target)).ok).toBe(true)

    const second = await mergeTopicProposal(client(), proposalId, target)
    expect(second).toEqual({ ok: false, reason: 'not_pending' })
  })

  it('reports a proposal that is not there', async () => {
    const target = await makeParent('competition-math.geometry.rhombi')

    expect(await mergeTopicProposal(client(), 'nope', target)).toEqual({
      ok: false,
      reason: 'not_found',
    })
  })

  it('merges a proposal that raised no source question, without tagging anything', async () => {
    const target = await makeParent('competition-math.geometry.trapezoids')
    const proposalId = await makeProposal({ proposedName: 'Trapezoids', sourceQuestionId: null })

    const outcome = await mergeTopicProposal(client(), proposalId, target)

    expect(outcome).toEqual({ ok: true, taggedSource: false })
  })
})

// The point of accepting one. The queue flipped the status, the tree grew a
// topic, and the topic was still unreachable, because shortlisting only looked
// at canonical topics and an accepted proposal is by definition not one. So
// accepting a proposal made the set classification could choose from smaller,
// and the next question that did not fit raised the same proposal again.
describe('an accepted proposal is classifiable', () => {
  it('shortlists the new topic for a vector near the one it was proposed with', async () => {
    const parentId = await makeParent('competition-math.number-theory')

    // Somewhere else in the space, so a shortlist that ignored the query
    // vector would still pass and this would prove nothing.
    await db.insert(topics).values({
      slug: 'competition-math.number-theory.parity',
      name: 'Parity',
      depth: 2,
      subjectRoot: 'competition-math',
      isCanonical: true,
      isLeaf: true,
      embedding: axis(300),
    })

    const accepted = await acceptTopicProposal(
      client(),
      await makeProposal({
        proposedName: 'Modular arithmetic',
        suggestedParentId: parentId,
        embedding: axis(5),
      }),
    )

    if (!accepted.ok) throw new Error(`expected acceptance, got ${accepted.reason}`)

    const shortlist = await shortlistByVector(client(), axis(5), { limit: 5 })

    expect(shortlist.map((candidate) => candidate.slug)).toContain(accepted.slug)
    expect(shortlist[0].slug).toBe(accepted.slug)
  })

  it('drops the parent from the shortlist once it has a child', async () => {
    const parentId = await makeParent('competition-math.sequences')

    await db.update(topics).set({ embedding: axis(11) }).where(eq(topics.id, parentId))

    const accepted = await acceptTopicProposal(
      client(),
      await makeProposal({
        proposedName: 'Arithmetic series',
        suggestedParentId: parentId,
        embedding: axis(11),
      }),
    )

    if (!accepted.ok) throw new Error(`expected acceptance, got ${accepted.reason}`)

    const slugs = (await shortlistByVector(client(), axis(11), { limit: 25 })).map(
      (candidate) => candidate.slug,
    )

    expect(slugs).toContain(accepted.slug)
    expect(slugs).not.toContain('competition-math.sequences')
  })

  // What `npm run db:seed` used to undo. The taxonomy file has never heard of
  // an accepted topic, so the seed wrote its parent back as a leaf and the
  // parent returned to the shortlist alongside the child it now has.
  it('keeps a parent demoted after the seed writes the taxonomy back over it', async () => {
    const parentId = await makeParent('competition-math.probability')

    const accepted = await acceptTopicProposal(
      client(),
      await makeProposal({
        proposedName: 'Conditional probability',
        suggestedParentId: parentId,
        embedding: axis(21),
      }),
    )

    if (!accepted.ok) throw new Error(`expected acceptance, got ${accepted.reason}`)

    // What the seed's UPDATE does: `isLeaf` straight off the taxonomy node.
    await db.update(topics).set({ isLeaf: true }).where(eq(topics.id, parentId))

    expect(await demoteParentsWithChildren(client())).toContain(
      'competition-math.probability',
    )

    const [parent] = await db
      .select({ isLeaf: topics.isLeaf })
      .from(topics)
      .where(eq(topics.id, parentId))

    expect(parent.isLeaf).toBe(false)
  })

  it('leaves a real leaf alone', async () => {
    const id = await makeParent('competition-math.logarithms')

    expect(await demoteParentsWithChildren(client())).not.toContain(
      'competition-math.logarithms',
    )

    const [row] = await db
      .select({ isLeaf: topics.isLeaf })
      .from(topics)
      .where(eq(topics.id, id))

    expect(row.isLeaf).toBe(true)
  })
})

describe('slugify', () => {
  it('makes a path-safe segment', () => {
    expect(slugify('Circle Theorems & Arcs')).toBe('circle-theorems-arcs')
  })

  it('never returns an empty segment, which would read as a missing level', () => {
    expect(slugify('!!!')).toBe('topic')
  })
})
