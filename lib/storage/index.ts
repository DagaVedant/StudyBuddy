import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'

import { del, head, put } from '@vercel/blob'

/**
 * Page images are a student's own schoolwork, so nothing here returns a public
 * URL. Callers get back an opaque key; reads go through /api/files, which
 * checks ownership before streaming (spec §8).
 *
 * Vercel Blob has no signed-URL API — its privacy model is an unguessable
 * public URL — which is why authorization lives in our route rather than in
 * the storage layer.
 */

export interface StorageDriver {
  readonly name: 'vercel-blob' | 'local'
  put(key: string, body: Buffer, contentType: string): Promise<void>
  get(key: string): Promise<{ body: Buffer; contentType: string } | null>
  remove(key: string): Promise<void>
}

/* -------------------------------------------------------------------------- */

const LOCAL_ROOT = join(process.cwd(), '.uploads')

/** Rejects traversal and absolute paths before a key ever reaches the disk. */
function safeLocalPath(key: string): string {
  const cleaned = normalize(key).replace(/^([.]{2}([/\\]|$))+/, '')
  const full = join(LOCAL_ROOT, cleaned)
  if (!full.startsWith(LOCAL_ROOT + sep)) {
    throw new Error('Invalid storage key')
  }
  return full
}

const localDriver: StorageDriver = {
  name: 'local',

  async put(key, body, contentType) {
    const path = safeLocalPath(key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, body)
    await writeFile(`${path}.meta`, contentType, 'utf8')
  },

  async get(key) {
    try {
      const path = safeLocalPath(key)
      const [body, contentType] = await Promise.all([
        readFile(path),
        readFile(`${path}.meta`, 'utf8').catch(() => 'application/octet-stream'),
      ])
      return { body, contentType }
    } catch {
      return null
    }
  },

  async remove(key) {
    const path = safeLocalPath(key)
    await Promise.allSettled([unlink(path), unlink(`${path}.meta`)])
  },
}

/* -------------------------------------------------------------------------- */

const blobDriver: StorageDriver = {
  name: 'vercel-blob',

  async put(key, body, contentType) {
    // addRandomSuffix would make the pathname unpredictable, and we need the
    // key we stored to be the key we can read back.
    await put(key, body, {
      access: 'public',
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
    })
  },

  async get(key) {
    try {
      const meta = await head(key)
      const response = await fetch(meta.url)
      if (!response.ok) return null
      return {
        body: Buffer.from(await response.arrayBuffer()),
        contentType: meta.contentType ?? 'application/octet-stream',
      }
    } catch {
      return null
    }
  },

  async remove(key) {
    try {
      const meta = await head(key)
      await del(meta.url)
    } catch {
      // Already gone.
    }
  },
}

/* -------------------------------------------------------------------------- */

export const storage: StorageDriver = process.env.BLOB_READ_WRITE_TOKEN
  ? blobDriver
  : localDriver

export function pageImageKey(worksheetId: string, pageNumber: number): string {
  return `pages/${worksheetId}/${String(pageNumber).padStart(3, '0')}.webp`
}

export function figureImageKey(worksheetId: string, questionId: string): string {
  return `figures/${worksheetId}/${questionId}.webp`
}
