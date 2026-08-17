import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ body: null as unknown }))

vi.mock('@vercel/blob', () => ({
  put: async (_key: string, body: unknown) => {
    state.body = body
    return { url: 'https://blob.example/x' }
  },
  get: async () => null,
  del: async () => {},
}))

const { selectDriver } = await import('@/lib/storage')

const blob = selectDriver({ BLOB_READ_WRITE_TOKEN: 'test-token' } as never)

describe('the blob driver', () => {
  it('is the driver under test', () => {
    expect(blob.name).toBe('vercel-blob')
  })

  it('uploads bytes this process owns, not a view into somebody else\u2019s memory', async () => {
    const pool = new ArrayBuffer(1024)
    const view = Buffer.from(pool, 128, 4)
    view.set([1, 2, 3, 4])

    await blob.put('pages/ws-1/001.webp', view, 'image/webp')

    const sent = state.body as Uint8Array

    expect(sent).toBeInstanceOf(Uint8Array)
    expect([...sent]).toEqual([1, 2, 3, 4])

    expect(sent.buffer).not.toBe(pool)
    expect(sent.byteOffset).toBe(0)
    expect(sent.buffer.byteLength).toBe(sent.byteLength)
    expect(sent.buffer instanceof SharedArrayBuffer).toBe(false)
  })

  it('copies rather than aliasing, so a later write cannot change what was sent', async () => {
    const source = Buffer.from([9, 9, 9])

    await blob.put('pages/ws-1/002.webp', source, 'image/webp')
    source[0] = 0

    expect([...(state.body as Uint8Array)]).toEqual([9, 9, 9])
  })

  it('carries an empty body through without throwing', async () => {
    await blob.put('pages/ws-1/003.webp', Buffer.alloc(0), 'image/webp')

    expect((state.body as Uint8Array).byteLength).toBe(0)
  })
})
