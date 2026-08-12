import { describe, expect, it, vi } from 'vitest'

/**
 * What the blob driver hands to `fetch`.
 *
 * Production refused every page upload with `TypeError: ArrayBuffer:
 * SharedArrayBuffer is not allowed`, thrown inside `fetch` from the blob SDK.
 * The body was a `Buffer` straight out of `sharp.toBuffer()`, which is a view
 * into memory the image library owns rather than memory this process
 * allocated, and `fetch` will not take a body whose backing store it cannot
 * prove is unshared.
 *
 * The platform check cannot be reproduced here: on this machine sharp is the
 * native build and its output is already standalone, which is exactly why the
 * whole test suite and every local build passed while the deployed app failed
 * on every upload. So this asserts the property that makes the platform check
 * pass rather than the check itself, which is the part that is ours to keep
 * true.
 */

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
    // A view into a larger buffer, which is the shape sharp returns: correct
    // contents, backing store owned elsewhere.
    const pool = new ArrayBuffer(1024)
    const view = Buffer.from(pool, 128, 4)
    view.set([1, 2, 3, 4])

    await blob.put('pages/ws-1/001.webp', view, 'image/webp')

    const sent = state.body as Uint8Array

    expect(sent).toBeInstanceOf(Uint8Array)
    expect([...sent]).toEqual([1, 2, 3, 4])

    /*
     * The four properties that together mean "ours, and not shared". The
     * offset and length pair is the fussy one: Buffer.from, allocUnsafe and
     * copyBytesFrom all carve their result out of Node's shared 64KB pool, so
     * each returns a view into a buffer holding unrelated data and each fails
     * this. Only Buffer.alloc allocates memory of its own.
     */
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
