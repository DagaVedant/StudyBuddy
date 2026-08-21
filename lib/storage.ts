import {createReadStream} from 'node:fs'
import {mkdir, readFile, stat, unlink, writeFile} from 'node:fs/promises'
import {dirname, join, normalize, sep} from 'node:path'
import {Readable} from 'node:stream'

import {del, get, put} from '@vercel/blob'

export interface StoredObject {
  body: Buffer
  contentType: string
}

export interface StoredStream {
  stream: ReadableStream<Uint8Array>
  contentType: string
  size: number | null
}

export interface StorageDriver {
  readonly name: 'vercel-blob' | 'local'
  put(key: string, body: Buffer, contentType: string): Promise<void>
  get(key: string): Promise<StoredObject | null>
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
    await mkdir(dirname(path), {recursive: true})
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
      return {body, contentType}
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

function detached(body: Buffer): Buffer {
  const copy = Buffer.alloc(body.byteLength)
  body.copy(copy)
  return copy
}

const blobDriver: StorageDriver = {
  name: 'vercel-blob',

  async put(key, body, contentType) {
    await put(key, detached(body), {
      access: 'private',
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
    })
  },

  async get(key) {
    try {
      const result = await get(key, {access: 'private'})
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
      const result = await get(key, {access: 'private'})
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

interface StorageEnv {
  BLOB_READ_WRITE_TOKEN?: string
  VERCEL_ENV?: string
}

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
