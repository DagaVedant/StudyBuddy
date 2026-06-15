import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Encryption for user-supplied API keys (spec §3.6).
 *
 * Background jobs need the key server-side, so client-only storage isn't
 * viable. Keys are stored as AES-256-GCM ciphertext under a master key held in
 * the environment, with a per-row IV and auth tag.
 */

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
    throw new Error('CREDENTIALS_ENC_KEY is not set — cannot handle API keys.')
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
    // Display-only suffix so settings can show "…4f2a" without decrypting.
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

/**
 * Ollama base URLs are not secrets, but they are user-supplied, so they're
 * pinned to loopback. Ollama calls run in the browser (spec §3.4) — the server
 * never dials them, and this stops the field being used as an SSRF lever if
 * that ever changes.
 */
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
