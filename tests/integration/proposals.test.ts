import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { acceptTopicProposal, slugify } from '@/lib/classify/proposals'
import { questionTopics, topicProposals, topics } from '@/lib/db/schema'

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
      subjectRoot: 'high-school-math',
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
}) {
  const [row] = await db
    .insert(topicProposals)
    .values({
      proposedName: over.proposedName,
      suggestedParentId: over.suggestedParentId ?? null,
      sourceQuestionId: over.sourceQuestionId ?? null,
      status: over.status ?? 'pending',
    })
    .returning({ id: topicProposals.id })

  return row.id
}

describe('acceptTopicProposal', () => {
  it('adds the topic under its suggested parent', async () => {
    const parentId = await makeParent('high-school-math.geometry')
    const proposalId = await makeProposal({
      proposedName: 'Circle theorems',
      suggestedParentId: parentId,
    })

    const outcome = await acceptTopicProposal(client(), proposalId)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    const [created] = await db.select().from(topics).where(eq(topics.id, outcome.topicId))

    expect(created.slug).toBe('high-school-math.geometry.circle-theorems')
    expect(created.name).toBe('Circle theorems')
    expect(created.parentId).toBe(parentId)
    expect(created.depth).toBe(2)
    expect(created.subjectRoot).toBe('high-school-math')
    expect(created.isLeaf).toBe(true)
    // It did not come from the seeded taxonomy, and a re-seed needs to know.
    expect(created.isCanonical).toBe(false)
  })

  it('records the proposal as accepted and points it at the new topic', async () => {
    const parentId = await makeParent('high-school-math.algebra')
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
    const parentId = await makeParent('high-school-math.stats', true)
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

    const parentId = await makeParent('high-school-math.number-sense')
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
    const parentId = await makeParent('high-school-math.trig')
    const proposalId = await makeProposal({
      proposedName: 'Unit circle',
      suggestedParentId: parentId,
    })

    expect((await acceptTopicProposal(client(), proposalId)).ok).toBe(true)

    const second = await acceptTopicProposal(client(), proposalId)
    expect(second).toEqual({ ok: false, reason: 'not_pending' })
  })

  it('does not collide when two proposals share a name under one parent', async () => {
    const parentId = await makeParent('high-school-math.functions')

    const first = await acceptTopicProposal(
      client(),
      await makeProposal({ proposedName: 'Inverses', suggestedParentId: parentId }),
    )
    const second = await acceptTopicProposal(
      client(),
      await makeProposal({ proposedName: 'Inverses', suggestedParentId: parentId }),
    )

    if (!first.ok || !second.ok) throw new Error('expected both to be accepted')
    expect(first.slug).toBe('high-school-math.functions.inverses')
    expect(second.slug).toBe('high-school-math.functions.inverses-2')
  })

  it('reports a proposal that is not there', async () => {
    expect(await acceptTopicProposal(client(), 'nope')).toEqual({
      ok: false,
      reason: 'not_found',
    })
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
