import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'

import { del, head, put } from '@vercel/blob'

export interface StorageDriver {
  readonly name: 'vercel-blob' | 'local'
  put(key: string, body: Buffer, contentType: string): Promise<void>
  get(key: string): Promise<{ body: Buffer; contentType: string } | null>
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

  async remove(key) {
    const path = safeLocalPath(key)
    await Promise.allSettled([unlink(path), unlink(`${path}.meta`)])
  },
}

const blobDriver: StorageDriver = {
  name: 'vercel-blob',

  async put(key, body, contentType) {

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

    }
  },
}

export const storage: StorageDriver = process.env.BLOB_READ_WRITE_TOKEN
  ? blobDriver
  : localDriver

export function pageImageKey(worksheetId: string, pageNumber: number): string {
  return `pages/${worksheetId}/${String(pageNumber).padStart(3, '0')}.webp`
}

export function figureImageKey(worksheetId: string, questionId: string): string {
  return `figures/${worksheetId}/${questionId}.webp`
}
