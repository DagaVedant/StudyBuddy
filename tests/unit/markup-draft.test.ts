import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearMarkupDraft,
  readMarkupDraft,
  writeMarkupDraft,
} from '@/lib/client/markup-draft'

/** A localStorage that behaves, so the tests can drive it directly. */
function store() {
  const data = new Map<string, string>()
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    raw: data,
  }
}

let local: ReturnType<typeof store>

beforeEach(() => {
  local = store()
  vi.stubGlobal('window', { localStorage: local })
})

describe('the markup draft', () => {
  it('comes back the way it went in', () => {
    writeMarkupDraft('ws-1', {
      outcomes: { 'q-1': 'wrong', 'q-2': 'correct' },
      answers: { 'q-1': 'B' },
      cursor: 3,
    })

    expect(readMarkupDraft('ws-1')).toEqual({
      outcomes: { 'q-1': 'wrong', 'q-2': 'correct' },
      answers: { 'q-1': 'B' },
      cursor: 3,
    })
  })

  it('is empty for a worksheet that has none', () => {
    expect(readMarkupDraft('ws-none')).toEqual({ outcomes: {}, answers: {}, cursor: 0 })
  })

  it('is kept per worksheet', () => {
    writeMarkupDraft('ws-1', { outcomes: { 'q-1': 'wrong' }, answers: {}, cursor: 0 })

    expect(readMarkupDraft('ws-2').outcomes).toEqual({})
  })

  it('is gone once the marks are posted', () => {
    writeMarkupDraft('ws-1', { outcomes: { 'q-1': 'wrong' }, answers: {}, cursor: 0 })
    clearMarkupDraft('ws-1')

    expect(readMarkupDraft('ws-1').outcomes).toEqual({})
  })

  /**
   * This is user-writable storage that survives deploys, so anything read back
   * has to be treated as suspect rather than spread into component state. An
   * outcome that is not one of the three would reach the attempts route and be
   * rejected there, after the student had marked a whole paper.
   */
  describe('reading something it did not write', () => {
    it.each([
      ['not JSON at all', 'nonsense{'],
      ['a JSON scalar', '42'],
      ['null', 'null'],
      ['an array', '[1,2,3]'],
    ])('falls back to empty on %s', (_case, raw) => {
      local.raw.set('studybuddy:markup:ws-1', raw)

      expect(readMarkupDraft('ws-1')).toEqual({ outcomes: {}, answers: {}, cursor: 0 })
    })

    it('drops an outcome that is not one of the three', () => {
      local.raw.set(
        'studybuddy:markup:ws-1',
        JSON.stringify({
          outcomes: { 'q-1': 'wrong', 'q-2': 'brilliant', 'q-3': 7 },
          answers: {},
          cursor: 0,
        }),
      )

      expect(readMarkupDraft('ws-1').outcomes).toEqual({ 'q-1': 'wrong' })
    })

    it('drops an answer that is not a short string', () => {
      local.raw.set(
        'studybuddy:markup:ws-1',
        JSON.stringify({
          outcomes: {},
          answers: { 'q-1': 'B', 'q-2': 'x'.repeat(5000), 'q-3': { nope: true } },
          cursor: 0,
        }),
      )

      expect(readMarkupDraft('ws-1').answers).toEqual({ 'q-1': 'B' })
    })

    it('refuses a cursor that is not a whole number at or above zero', () => {
      for (const cursor of [-1, 1.5, 'three', null]) {
        local.raw.set(
          'studybuddy:markup:ws-1',
          JSON.stringify({ outcomes: {}, answers: {}, cursor }),
        )

        expect(readMarkupDraft('ws-1').cursor).toBe(0)
      }
    })
  })

  /** Private browsing and a full quota both throw. Neither is worth a crash. */
  it('survives a storage that throws', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('denied')
        },
        setItem: () => {
          throw new Error('denied')
        },
        removeItem: () => {
          throw new Error('denied')
        },
      },
    })

    expect(readMarkupDraft('ws-1')).toEqual({ outcomes: {}, answers: {}, cursor: 0 })
    expect(() =>
      writeMarkupDraft('ws-1', { outcomes: {}, answers: {}, cursor: 0 }),
    ).not.toThrow()
    expect(() => clearMarkupDraft('ws-1')).not.toThrow()
  })
})
