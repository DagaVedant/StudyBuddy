import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/embeddings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/embeddings')>()
  return {
    ...actual,
    embed: vi.fn(async () => {
      throw new Error('onnxruntime-node failed to load')
    }),
  }
})

const { eq } = await import('drizzle-orm')
const { proposeTopic } = await import('@/lib/classify')
const { topicProposals } = await import('@/lib/db/schema')
const { asDb, createTestDb } = await import('../helpers/db')

let db: Awaited<ReturnType<typeof createTestDb>>['db']
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

describe('proposeTopic on a host that cannot embed', () => {
  it('still records the proposal, without a vector to dedupe on', async () => {
    const id = await proposeTopic(client(), {
      name: 'Modular arithmetic',
      questionId: null,
      userId: null,
      parentId: null,
    })

    expect(id).not.toBeNull()

    const [row] = await db
      .select({
        proposedName: topicProposals.proposedName,
        embedding: topicProposals.embedding,
      })
      .from(topicProposals)
      .where(eq(topicProposals.id, id!))

    expect(row.proposedName).toBe('Modular arithmetic')
    expect(row.embedding).toBeNull()
  })

  it('does not fold two proposals together when it cannot compare them', async () => {
    const first = await proposeTopic(client(), {
      name: 'Counting problems',
      questionId: null,
      userId: null,
      parentId: null,
    })

    const second = await proposeTopic(client(), {
      name: 'Counting problems',
      questionId: null,
      userId: null,
      parentId: null,
    })

    expect(first).not.toBe(second)
  })
})
