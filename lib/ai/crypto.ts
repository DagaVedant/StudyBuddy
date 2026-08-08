import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12

export interface SealedKey {
  ciphertext: string
  iv: string
  authTag: string
  last4: string
}

function masterKey(): Buffer {
  const raw = process.env.CREDENTIALS_ENC_KEY
  if (!raw) {
    throw new Error('CREDENTIALS_ENC_KEY is not set; cannot handle API keys.')
  }

  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error(
      'CREDENTIALS_ENC_KEY must be 32 bytes base64-encoded. Generate one with: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    )
  }

  return key
}

export function sealApiKey(plaintext: string): SealedKey {
  const trimmed = plaintext.trim()
  if (!trimmed) throw new Error('Cannot store an empty API key.')

  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, masterKey(), iv)

  const ciphertext = Buffer.concat([
    cipher.update(trimmed, 'utf8'),
    cipher.final(),
  ])

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    last4: trimmed.slice(-4),
  }
}

export function openApiKey(sealed: Omit<SealedKey, 'last4'>): string {
  const decipher = createDecipheriv(
    ALGORITHM,
    masterKey(),
    Buffer.from(sealed.iv, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'))

  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

export function isAllowedOllamaUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false

  const host = url.hostname.toLowerCase()
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.localhost')
  )
}
