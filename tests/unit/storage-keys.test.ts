import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { pageImageKey, selectDriver } from '@/lib/storage'

/**
 * The traversal defence on the local storage driver.
 *
 * Keys reach it from `/api/files/[...key]`, which is a catch-all: whatever the
 * URL says becomes path segments. The driver joins them onto `.uploads` and
 * reads the result, so a key that escapes that directory is a read of any file
 * the server process can open. There was no test on it.
 *
 * Exercised through the driver rather than by exporting the helper, because the
 * claim worth making is about the thing the route calls.
 */

const local = selectDriver({} as never)
const ROOT = join(process.cwd(), '.uploads')

afterAll(async () => {
  await rm(join(ROOT, 'traversal-test'), { recursive: true, force: true })
})

describe('the local driver', () => {
  it('is what an environment with no blob token gets', () => {
    expect(local.name).toBe('local')
  })

  /**
   * Stated as containment rather than as rejection, because rejection is not
   * what the driver promises and asserting it would have been a test that
   * passed for the wrong reason. `normalize` hoists every `..` to the front,
   * the strip removes them, and the join lands back inside `.uploads`, so most
   * of these resolve to a harmless key rather than throwing. What matters is
   * that none of them names a file outside the root, and the canary is what
   * makes that a real claim: it exists, it is readable, and it is one segment
   * up from where these keys are allowed to look.
   */
  const CANARY = join(process.cwd(), 'traversal-canary.txt')

  it.each([
    ['a parent segment', '../traversal-canary.txt'],
    ['several', '../../../../etc/passwd'],
    ['one in the middle', 'pages/../../traversal-canary.txt'],
    ['a backslash form', '..\\..\\traversal-canary.txt'],
    ['a mixed form', 'pages/..\\../traversal-canary.txt'],
    ['an absolute posix path', '/etc/passwd'],
    ['a bare parent', '..'],
    ['a doubled-up parent that survives one strip', '....//....//traversal-canary.txt'],
    ['a url-ish key', '..%2Ftraversal-canary.txt'],
  ])('cannot reach outside the root with %s', async (_case, key) => {
    await writeFile(CANARY, 'canary')

    try {
      expect(await local.get(key)).toBeNull()
      expect(await local.getStream(key)).toBeNull()

      // Writing is the other half. A key that escapes on the way in is a way to
      // overwrite anything the process can write, which is worse than reading.
      await local.put(key, Buffer.from('overwritten'), 'text/plain').catch(() => {})
      expect((await readFile(CANARY)).toString()).toBe('canary')

      await local.remove(key).catch(() => {})
      expect((await readFile(CANARY)).toString()).toBe('canary')
    } finally {
      await rm(CANARY, { force: true })
    }
  })

  it('does throw for a key it cannot bring inside the root', async () => {
    // The prefix check, as opposed to the strip. Kept as its own assertion so
    // that removing it shows up as a failure rather than as one fewer safeguard
    // behind an outcome the strip happens to cover too.
    await expect(
      local.put('..', Buffer.from('x'), 'text/plain'),
    ).rejects.toThrow('Invalid storage key')
  })

  it('reads back what it wrote under a normal key', async () => {
    const key = 'traversal-test/nested/page.webp'
    await local.put(key, Buffer.from('image-bytes'), 'image/webp')

    const stored = await local.get(key)

    expect(stored?.body.toString()).toBe('image-bytes')
    expect(stored?.contentType).toBe('image/webp')
    expect((await readFile(join(ROOT, key))).toString()).toBe('image-bytes')
  })

  it('answers null for a key that was never written', async () => {
    expect(await local.get('traversal-test/absent.webp')).toBeNull()
    expect(await local.getStream('traversal-test/absent.webp')).toBeNull()
  })

  it('removes what it wrote', async () => {
    const key = 'traversal-test/gone.webp'
    await local.put(key, Buffer.from('x'), 'image/webp')

    await local.remove(key)

    expect(await local.get(key)).toBeNull()
  })
})

describe('selectDriver', () => {
  it('prefers blob when a token is present', () => {
    expect(selectDriver({ BLOB_READ_WRITE_TOKEN: 'token' } as never).name).toBe(
      'vercel-blob',
    )
  })

  /**
   * The failure this replaces was silent: uploads were accepted onto a
   * serverless filesystem that is thrown away between invocations, so the pages
   * existed until the function recycled and then did not.
   */
  it('refuses to fall back to disk on a deployment', () => {
    expect(() => selectDriver({ VERCEL_ENV: 'production' } as never)).toThrow(
      /BLOB_READ_WRITE_TOKEN/,
    )
  })

  it('takes the token over the deployment check', () => {
    expect(
      selectDriver({ VERCEL_ENV: 'production', BLOB_READ_WRITE_TOKEN: 't' } as never).name,
    ).toBe('vercel-blob')
  })
})

describe('pageImageKey', () => {
  // Zero-padded so that a plain lexicographic listing is page order. Page 10
  // sorting before page 2 is how a worksheet comes back shuffled.
  it('pads the page number so keys sort in page order', () => {
    expect(pageImageKey('ws-1', 2)).toBe('pages/ws-1/002.webp')
    expect(pageImageKey('ws-1', 10)).toBe('pages/ws-1/010.webp')
    expect([pageImageKey('ws-1', 10), pageImageKey('ws-1', 2)].sort()).toEqual([
      'pages/ws-1/002.webp',
      'pages/ws-1/010.webp',
    ])
  })

  it('keeps three digits past a hundred rather than truncating', () => {
    expect(pageImageKey('ws-1', 114)).toBe('pages/ws-1/114.webp')
    expect(pageImageKey('ws-1', 1000)).toBe('pages/ws-1/1000.webp')
  })
})
