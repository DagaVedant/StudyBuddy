import { afterEach, describe, expect, it } from 'vitest'

import { inviteAccepted, inviteRequired } from '@/lib/auth/invite'

afterEach(() => {
  delete process.env.SIGNUP_INVITE_CODE
})

describe('the signup invite gate', () => {
  it('is off unless a code is configured', () => {
    expect(inviteRequired()).toBe(false)
    expect(inviteAccepted('')).toBe(true)
    expect(inviteAccepted('anything')).toBe(true)
  })

  it('is off for an empty code, rather than demanding an empty string', () => {
    process.env.SIGNUP_INVITE_CODE = '   '

    expect(inviteRequired()).toBe(false)
    expect(inviteAccepted('')).toBe(true)
  })

  it('accepts the code and refuses everything else', () => {
    process.env.SIGNUP_INVITE_CODE = 'amc8-2026'

    expect(inviteRequired()).toBe(true)
    expect(inviteAccepted('amc8-2026')).toBe(true)
    expect(inviteAccepted(' amc8-2026 ')).toBe(true)
    expect(inviteAccepted('amc8-2025')).toBe(false)
    expect(inviteAccepted('')).toBe(false)
    expect(inviteAccepted('amc8-2026-and-more')).toBe(false)
  })
})
