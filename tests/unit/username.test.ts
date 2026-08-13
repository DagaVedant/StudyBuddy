import { describe, expect, it } from 'vitest'

import {
  MAX_USERNAME_LENGTH,
  MIN_USERNAME_LENGTH,
  validateUsername,
} from '@/lib/auth/username'

describe('validateUsername', () => {
  it('accepts a normal handle', () => {
    expect(validateUsername('daga_v')).toEqual({ ok: true, username: 'daga_v' })
  })

  it('lowercases on the way out, matching how email is normalized', () => {
    expect(validateUsername('DagaV')).toEqual({ ok: true, username: 'dagav' })
  })

  it('trims surrounding space', () => {
    expect(validateUsername('  daga  ')).toEqual({ ok: true, username: 'daga' })
  })

  it('rejects nothing entered', () => {
    expect(validateUsername(null).ok).toBe(false)
    expect(validateUsername(undefined).ok).toBe(false)
    expect(validateUsername('   ').ok).toBe(false)
  })

  it('rejects shorter than the minimum', () => {
    expect(validateUsername('a'.repeat(MIN_USERNAME_LENGTH - 1)).ok).toBe(false)
    expect(validateUsername('a'.repeat(MIN_USERNAME_LENGTH)).ok).toBe(true)
  })

  it('rejects longer than the maximum', () => {
    expect(validateUsername('a'.repeat(MAX_USERNAME_LENGTH + 1)).ok).toBe(false)
    expect(validateUsername('a'.repeat(MAX_USERNAME_LENGTH)).ok).toBe(true)
  })

  it('rejects a leading digit or underscore', () => {
    expect(validateUsername('1daga').ok).toBe(false)
    expect(validateUsername('_daga').ok).toBe(false)
  })

  it('rejects characters outside letters, digits and underscore', () => {
    for (const bad of ['daga.v', 'daga-v', 'daga v', 'daga@v', 'daga!']) {
      expect(validateUsername(bad).ok, bad).toBe(false)
    }
  })

  it('accepts digits after the first character', () => {
    expect(validateUsername('daga2').ok).toBe(true)
  })
})
