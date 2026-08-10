import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'
import { Readable } from 'node:stream'

import { del, get, put } from '@vercel/blob'

export interface StoredObject {
  body: Buffer
  contentType: string
}

export interface StoredStream {
  stream: ReadableStream<Uint8Array>
  contentType: string
  /** Null when the driver cannot say without reading the whole thing. */
  size: number | null
}

export interface StorageDriver {
  readonly name: 'vercel-blob' | 'local'
  put(key: string, body: Buffer, contentType: string): Promise<void>
  /** The whole object in memory. For callers that need the bytes, like the model. */
  get(key: string): Promise<StoredObject | null>
  /**
   * The object as a stream, for callers that only pass it on.
   *
   * Serving a page image through `get` held the whole file resident and then
   * copied it again into a Uint8Array for the response, so a 4 MB scan cost
   * about 8 MB per request in flight, on a serverless function sized in
   * hundreds of megabytes. Both storage backends hand out a stream natively;
   * only this contract was forcing them to be buffered.
   */
  getStream(key: string): Promise<StoredStream | null>
  remove(key: string): Promise<void>
}

const LOCAL_ROOT = join(process.cwd(), '.uploads')

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

  async getStream(key) {
    try {
      const path = safeLocalPath(key)
      const [info, contentType] = await Promise.all([
        stat(path),
        readFile(`${path}.meta`, 'utf8').catch(() => 'application/octet-stream'),
      ])

      return {
        stream: Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,
        contentType,
        size: info.size,
      }
    } catch {
      return null
    }
  },

  async remove(key) {
    const path = safeLocalPath(key)
    await Promise.allSettled([unlink(path), unlink(`${path}.meta`)])
  },
}

const blobDriver: StorageDriver = {
  name: 'vercel-blob',

  async put(key, body, contentType) {
    // The store this app was provisioned with is private-access-only:
    // uploading with access: 'public' is rejected outright, not just
    // served without a public URL. Reads go through the SDK's own
    // authenticated get() below rather than a bare public URL fetch.
    await put(key, body, {
      access: 'private',
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
    })
  },

  async get(key) {
    try {
      const result = await get(key, { access: 'private' })
      if (!result) return null
      return {
        body: Buffer.from(await new Response(result.stream).arrayBuffer()),
        contentType: result.blob.contentType ?? 'application/octet-stream',
      }
    } catch {
      return null
    }
  },

  async getStream(key) {
    try {
      const result = await get(key, { access: 'private' })
      if (!result) return null

      return {
        stream: result.stream as ReadableStream<Uint8Array>,
        contentType: result.blob.contentType ?? 'application/octet-stream',
        size: result.blob.size ?? null,
      }
    } catch {
      return null
    }
  },

  async remove(key) {
    await del(key).catch(() => {})
  },
}

/** Only what the choice reads. `ProcessEnv` insists on NODE_ENV, which it does not. */
interface StorageEnv {
  BLOB_READ_WRITE_TOKEN?: string
  VERCEL_ENV?: string
}

/**
 * Which driver a given environment gets, and whether that is allowed.
 *
 * The local driver writes under `.uploads` in the working directory. On a
 * serverless host that directory is per-invocation and gone by the time anyone
 * reads it back, so a deployment missing `BLOB_READ_WRITE_TOKEN` did not fail:
 * it accepted every page upload and then answered "Page image missing" when the
 * worker came for them, or returned an opaque 500. Silently degrading to a
 * driver that cannot work is worse than not booting.
 *
 * Deployment is `VERCEL_ENV`, not `NODE_ENV`. The e2e suite runs
 * `next build && npx next start` (playwright.config.ts:44) with no blob token
 * and deliberately uses the local driver, so `NODE_ENV` reads production there
 * too and gating on it would refuse the whole suite.
 */
export function selectDriver(env: StorageEnv = process.env as StorageEnv): StorageDriver {
  if (env.BLOB_READ_WRITE_TOKEN) return blobDriver

  if (env.VERCEL_ENV) {
    throw new Error(
      'BLOB_READ_WRITE_TOKEN is not set. The local-disk fallback cannot work on a ' +
        'serverless host: uploads would be accepted and then unreadable. Set the ' +
        'token, or run outside a deployment.',
    )
  }

  return localDriver
}

export const storage: StorageDriver = selectDriver()

export function pageImageKey(worksheetId: string, pageNumber: number): string {
  return `pages/${worksheetId}/${String(pageNumber).padStart(3, '0')}.webp`
}
