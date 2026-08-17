import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTopic, renameTopic, reparentTopic } from '@/lib/taxonomy/edit'
import { topics } from '@/lib/db/schema'
import { EMBEDDING_DIMENSIONS, disposeExtractor } from '@/lib/embeddings'

import { asDb, createTestDb, type TestDb } from '../helpers/db'

let db: TestDb
let close: () => Promise<void>

beforeAll(async () => {
  const created = await createTestDb()
  db = created.db
  close = created.close
})

afterAll(async () => {
  await disposeExtractor()
  await close()
})

const client = () => asDb(db)

async function makeTopic(over: {
  slug: string
  name?: string
  parentId?: string | null
  depth?: number
  isLeaf?: boolean
  subjectRoot?: string
}) {
  const [row] = await db
    .insert(topics)
    .values({
      slug: over.slug,
      name: over.name ?? 'Geometry',
      parentId: over.parentId ?? null,
      depth: over.depth ?? 1,
      subjectRoot: over.subjectRoot ?? 'competition-math',
      isCanonical: true,
      isLeaf: over.isLeaf ?? true,
    })
    .returning({ id: topics.id })

  return row.id
}

describe('createTopic', () => {
  it('adds a topic under its parent with a real embedding', async () => {
    const parentId = await makeTopic({ slug: 'competition-math.trig-2' })

    const outcome = await createTopic(client(), parentId, 'Law of Cosines')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    const [created] = await db.select().from(topics).where(eq(topics.id, outcome.topicId))
    expect(created.slug).toBe('competition-math.trig-2.law-of-cosines')
    expect(created.name).toBe('Law of Cosines')
    expect(created.isLeaf).toBe(true)
    expect(created.isCanonical).toBe(false)
    expect(created.embedding).toHaveLength(EMBEDDING_DIMENSIONS)
  }, 20_000)

  it('stops the parent being a leaf', async () => {
    const parentId = await makeTopic({ slug: 'competition-math.stats-2', isLeaf: true })

    await createTopic(client(), parentId, 'Standard deviation')

    const [parent] = await db.select().from(topics).where(eq(topics.id, parentId))
    expect(parent.isLeaf).toBe(false)
  }, 20_000)

  it('refuses a parent that does not exist', async () => {
    expect(await createTopic(client(), 'nope', 'Orphan')).toEqual({
      ok: false,
      reason: 'parent_not_found',
    })
  })

  it('avoids colliding with a sibling of the same name', async () => {
    const parentId = await makeTopic({ slug: 'competition-math.functions-2' })

    const first = await createTopic(client(), parentId, 'Inverses')
    const second = await createTopic(client(), parentId, 'Inverses')

    if (!first.ok || !second.ok) throw new Error('expected both to succeed')
    expect(first.slug).toBe('competition-math.functions-2.inverses')
    expect(second.slug).toBe('competition-math.functions-2.inverses-2')
  }, 20_000)
})

describe('renameTopic', () => {
  it('changes the name and leaves the slug alone', async () => {
    const id = await makeTopic({ slug: 'competition-math.circles-2', name: 'Circles' })

    expect(await renameTopic(client(), id, 'Circle theorems')).toEqual({ ok: true })

    const [row] = await db.select().from(topics).where(eq(topics.id, id))
    expect(row.name).toBe('Circle theorems')
    expect(row.slug).toBe('competition-math.circles-2')
  })

  it('reports a topic that does not exist', async () => {
    expect(await renameTopic(client(), 'nope', 'New name')).toEqual({
      ok: false,
      reason: 'not_found',
    })
  })

  it('refuses a blank name', async () => {
    const id = await makeTopic({ slug: 'competition-math.blank-target' })

    expect(await renameTopic(client(), id, '   ')).toEqual({ ok: false, reason: 'not_found' })

    const [row] = await db.select().from(topics).where(eq(topics.id, id))
    expect(row.name).not.toBe('')
  })
})

describe('reparentTopic', () => {
  it('moves a leaf under a new parent and mints a slug there', async () => {
    const oldParent = await makeTopic({ slug: 'competition-math.old-parent', isLeaf: false })
    const newParent = await makeTopic({ slug: 'competition-math.new-parent', isLeaf: false })
    const leaf = await makeTopic({
      slug: 'competition-math.old-parent.misfiled',
      parentId: oldParent,
      depth: 2,
    })

    const outcome = await reparentTopic(client(), leaf, newParent)
    expect(outcome).toEqual({ ok: true, slug: 'competition-math.new-parent.misfiled' })

    const [row] = await db.select().from(topics).where(eq(topics.id, leaf))
    expect(row.parentId).toBe(newParent)
    expect(row.slug).toBe('competition-math.new-parent.misfiled')
    expect(row.depth).toBe(2)
  })

  it('promotes the new parent out of leaf status', async () => {
    const newParent = await makeTopic({ slug: 'competition-math.gains-a-child', isLeaf: true })
    const leaf = await makeTopic({ slug: 'competition-math.wanders-in' })

    await reparentTopic(client(), leaf, newParent)

    const [row] = await db.select().from(topics).where(eq(topics.id, newParent))
    expect(row.isLeaf).toBe(false)
  })

  it('demotes the old parent back to a leaf once it has no children left', async () => {
    const oldParent = await makeTopic({ slug: 'competition-math.emptied-out', isLeaf: false })
    const newParent = await makeTopic({ slug: 'competition-math.receiving-end', isLeaf: false })
    const onlyChild = await makeTopic({
      slug: 'competition-math.emptied-out.only-child',
      parentId: oldParent,
      depth: 2,
    })

    await reparentTopic(client(), onlyChild, newParent)

    const [row] = await db.select().from(topics).where(eq(topics.id, oldParent))
    expect(row.isLeaf).toBe(true)
  })

  it('leaves the old parent alone when a sibling is still there', async () => {
    const oldParent = await makeTopic({ slug: 'competition-math.still-has-one', isLeaf: false })
    const newParent = await makeTopic({ slug: 'competition-math.another-target', isLeaf: false })
    const moving = await makeTopic({
      slug: 'competition-math.still-has-one.leaving',
      parentId: oldParent,
      depth: 2,
    })
    await makeTopic({
      slug: 'competition-math.still-has-one.staying',
      parentId: oldParent,
      depth: 2,
    })

    await reparentTopic(client(), moving, newParent)

    const [row] = await db.select().from(topics).where(eq(topics.id, oldParent))
    expect(row.isLeaf).toBe(false)
  })

  it('refuses to move an internal node, which would strand its descendants slugs', async () => {
    const branch = await makeTopic({ slug: 'competition-math.a-branch', isLeaf: false })
    await makeTopic({
      slug: 'competition-math.a-branch.a-child',
      parentId: branch,
      depth: 2,
    })
    const target = await makeTopic({ slug: 'competition-math.somewhere-else', isLeaf: false })

    expect(await reparentTopic(client(), branch, target)).toEqual({
      ok: false,
      reason: 'not_leaf',
    })
  })

  it('refuses a topic that does not exist', async () => {
    const target = await makeTopic({ slug: 'competition-math.real-target' })

    expect(await reparentTopic(client(), 'nope', target)).toEqual({
      ok: false,
      reason: 'not_found',
    })
  })

  it('refuses a target that does not exist', async () => {
    const leaf = await makeTopic({ slug: 'competition-math.a-real-leaf' })

    expect(await reparentTopic(client(), leaf, 'nope')).toEqual({
      ok: false,
      reason: 'target_not_found',
    })
  })

  it('refuses moving a topic under itself', async () => {
    const leaf = await makeTopic({ slug: 'competition-math.self-target' })

    expect(await reparentTopic(client(), leaf, leaf)).toEqual({
      ok: false,
      reason: 'target_is_self',
    })
  })

  it('refuses a no-op move to the same parent', async () => {
    const parent = await makeTopic({ slug: 'competition-math.unchanged-parent', isLeaf: false })
    const leaf = await makeTopic({
      slug: 'competition-math.unchanged-parent.child',
      parentId: parent,
      depth: 2,
    })

    expect(await reparentTopic(client(), leaf, parent)).toEqual({
      ok: false,
      reason: 'same_parent',
    })
  })
})
