import { randomBytes } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { isAllowedOllamaUrl, openApiKey, sealApiKey } from '@/lib/ai/crypto'

const REAL_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz-01234f2a'
let previous: string | undefined

beforeAll(() => {
  previous = process.env.CREDENTIALS_ENC_KEY
  process.env.CREDENTIALS_ENC_KEY = randomBytes(32).toString('base64')
})

afterAll(() => {
  process.env.CREDENTIALS_ENC_KEY = previous
})

describe('sealApiKey / openApiKey', () => {
  it('round-trips a key', () => {
    const sealed = sealApiKey(REAL_KEY)
    expect(openApiKey(sealed)).toBe(REAL_KEY)
  })

  it('never stores the key in readable form', () => {
    const sealed = sealApiKey(REAL_KEY)
    expect(sealed.ciphertext).not.toContain(REAL_KEY)
    expect(Buffer.from(sealed.ciphertext, 'base64').toString('utf8')).not.toContain(
      'sk-ant',
    )
  })

  it('keeps only the last four characters for display', () => {
    expect(sealApiKey(REAL_KEY).last4).toBe('4f2a')
  })

  it('produces a different ciphertext each time', () => {
    const a = sealApiKey(REAL_KEY)
    const b = sealApiKey(REAL_KEY)
    expect(a.ciphertext).not.toBe(b.ciphertext)
    expect(a.iv).not.toBe(b.iv)
  })

  it('rejects tampered ciphertext', () => {
    const sealed = sealApiKey(REAL_KEY)
    const bytes = Buffer.from(sealed.ciphertext, 'base64')
    bytes[0] ^= 0xff

    expect(() =>
      openApiKey({ ...sealed, ciphertext: bytes.toString('base64') }),
    ).toThrow()
  })

  it('rejects a tampered auth tag', () => {
    const sealed = sealApiKey(REAL_KEY)
    const tag = Buffer.from(sealed.authTag, 'base64')
    tag[0] ^= 0xff

    expect(() => openApiKey({ ...sealed, authTag: tag.toString('base64') })).toThrow()
  })

  it('refuses an empty key', () => {
    expect(() => sealApiKey('   ')).toThrow(/empty/i)
  })

  it('refuses a master key of the wrong length', () => {
    const saved = process.env.CREDENTIALS_ENC_KEY
    process.env.CREDENTIALS_ENC_KEY = Buffer.from('too short').toString('base64')
    expect(() => sealApiKey(REAL_KEY)).toThrow(/32 bytes/)
    process.env.CREDENTIALS_ENC_KEY = saved
  })
})

describe('isAllowedOllamaUrl', () => {
  it('accepts loopback', () => {
    expect(isAllowedOllamaUrl('http://localhost:11434')).toBe(true)
    expect(isAllowedOllamaUrl('http://127.0.0.1:11434')).toBe(true)
    expect(isAllowedOllamaUrl('http://app.localhost:11434')).toBe(true)
  })

  it('rejects anything that could be used as an SSRF lever', () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://192.168.1.10:11434',
      'http://example.com',
      'file:///etc/passwd',
      'not a url',
      '',
    ]) {
      expect(isAllowedOllamaUrl(url), url).toBe(false)
    }
  })
})
