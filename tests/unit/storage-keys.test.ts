import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { pageImageKey, selectDriver } from '@/lib/storage'

const local = selectDriver({} as never)
const ROOT = join(process.cwd(), '.uploads')

afterAll(async () => {
  await rm(join(ROOT, 'traversal-test'), { recursive: true, force: true })
})

describe('the local driver', () => {
  it('is what an environment with no blob token gets', () => {
    expect(local.name).toBe('local')
  })

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

      await local.put(key, Buffer.from('overwritten'), 'text/plain').catch(() => {})
      expect((await readFile(CANARY)).toString()).toBe('canary')

      await local.remove(key).catch(() => {})
      expect((await readFile(CANARY)).toString()).toBe('canary')
    } finally {
      await rm(CANARY, { force: true })
    }
  })

  it('does throw for a key it cannot bring inside the root', async () => {
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
