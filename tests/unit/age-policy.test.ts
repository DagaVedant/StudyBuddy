import { afterEach, describe, expect, it } from 'vitest'

import {
  MIN_AGE_YEARS,
  ageInYears,
  adminEmails,
  isAdminEmail,
  meetsAgeRequirement,
  validateDob,
} from '@/lib/auth/policy'
const original = { ...process.env }

afterEach(() => {
  process.env = { ...original }
})

describe('ageInYears', () => {
  it('counts whole years, not the difference in year numbers', () => {
    const now = new Date('2026-08-11T00:00:00Z')

    expect(ageInYears(new Date('2013-08-11T00:00:00Z'), now)).toBe(13)
    expect(ageInYears(new Date('2013-08-12T00:00:00Z'), now)).toBe(12)
    expect(ageInYears(new Date('2013-08-10T00:00:00Z'), now)).toBe(13)
  })

  it('handles a birthday later in the same month', () => {
    const now = new Date('2026-08-01T00:00:00Z')

    expect(ageInYears(new Date('2013-08-31T00:00:00Z'), now)).toBe(12)
  })

  it('handles a birthday in a later month of the same year', () => {
    const now = new Date('2026-03-15T00:00:00Z')

    expect(ageInYears(new Date('2013-11-01T00:00:00Z'), now)).toBe(12)
    expect(ageInYears(new Date('2013-01-01T00:00:00Z'), now)).toBe(13)
  })

  it('handles the leap day', () => {
    expect(ageInYears(new Date('2012-02-29T00:00:00Z'), new Date('2026-02-28T00:00:00Z'))).toBe(
      13,
    )
    expect(ageInYears(new Date('2012-02-29T00:00:00Z'), new Date('2026-03-01T00:00:00Z'))).toBe(
      14,
    )
  })
})

describe('meetsAgeRequirement', () => {
  const now = new Date('2026-08-11T00:00:00Z')

  it('admits somebody who turns 13 today', () => {
    expect(meetsAgeRequirement(new Date('2013-08-11T00:00:00Z'), now)).toBe(true)
  })

  it('refuses somebody who turns 13 tomorrow', () => {
    expect(meetsAgeRequirement(new Date('2013-08-12T00:00:00Z'), now)).toBe(false)
  })

  it('agrees with the constant it is named for', () => {
    const exactly = new Date(now)
    exactly.setUTCFullYear(now.getUTCFullYear() - MIN_AGE_YEARS)

    expect(meetsAgeRequirement(exactly, now)).toBe(true)
  })
})

describe('validateDob', () => {
  it.each([
    ['nothing', undefined],
    ['null', null],
    ['an empty string', ''],
  ])('asks for one when given %s', (_case, input) => {
    expect(validateDob(input)).toEqual({
      ok: false,
      reason: 'Enter your date of birth.',
    })
  })

  it.each([
    ['prose', 'sometime in 2010'],
    ['a bare year', '2010'],
    ['a month and year', 'May 2010'],
    ['a malformed date', '2013-13-45'],
    ['a number as a string', '99999999999999999999'],
    ['a slashed date', '15/06/2000'],
    ['a full timestamp', '2000-06-15T12:00:00Z'],
  ])('refuses %s', (_case, input) => {
    expect(validateDob(input)).toEqual({
      ok: false,
      reason: 'That date of birth is not valid.',
    })
  })

  it('reads the date in UTC, not in whatever zone the server is in', () => {
    const result = validateDob('2000-06-15')

    expect(result.ok === true && result.dob.getUTCDate()).toBe(15)
    expect(result.ok === true && result.dob.getUTCHours()).toBe(0)
  })

  it('refuses a date in the future', () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)

    expect(validateDob(tomorrow)).toEqual({
      ok: false,
      reason: 'That date of birth is in the future.',
    })
  })

  it('refuses an implausible age', () => {
    expect(validateDob('1013-05-04')).toEqual({
      ok: false,
      reason: 'That date of birth is not valid.',
    })
  })

  it('names the rule when somebody is too young', () => {
    const nineYearsAgo = new Date()
    nineYearsAgo.setUTCFullYear(nineYearsAgo.getUTCFullYear() - 9)

    const result = validateDob(nineYearsAgo)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain(String(MIN_AGE_YEARS))
  })

  it('accepts an adult, as a string or as a Date', () => {
    const twenty = new Date()
    twenty.setUTCFullYear(twenty.getUTCFullYear() - 20)

    expect(validateDob(twenty).ok).toBe(true)
    expect(validateDob(twenty.toISOString().slice(0, 10)).ok).toBe(true)
  })

  it('hands back the parsed date, so the caller does not parse it again', () => {
    const result = validateDob('2000-06-15')

    expect(result.ok).toBe(true)
    expect(result.ok === true && result.dob.toISOString()).toBe('2000-06-15T00:00:00.000Z')
  })
})

describe('the admin allowlist', () => {
  it('is empty when unset, so nobody is admin by default', () => {
    delete process.env.ADMIN_EMAILS

    expect(adminEmails()).toEqual([])
    expect(isAdminEmail('anyone@example.com')).toBe(false)
  })

  it('is empty when blank, rather than holding one empty entry', () => {
    process.env.ADMIN_EMAILS = ' , ,, '

    expect(adminEmails()).toEqual([])
    expect(isAdminEmail('')).toBe(false)
  })

  it('splits on commas and trims', () => {
    process.env.ADMIN_EMAILS = ' boss@studybuddy.test , ops@studybuddy.test'

    expect(adminEmails()).toEqual(['boss@studybuddy.test', 'ops@studybuddy.test'])
  })

  it('matches regardless of case on either side', () => {
    process.env.ADMIN_EMAILS = 'Boss@StudyBuddy.test'

    expect(isAdminEmail('boss@studybuddy.test')).toBe(true)
    expect(isAdminEmail('BOSS@STUDYBUDDY.TEST')).toBe(true)
  })

  it.each([
    ['a different address', 'other@studybuddy.test'],
    ['a prefix', 'boss@studybuddy.tes'],
    ['a suffix', 'boss@studybuddy.test.evil.com'],
    ['a plus-address of it', 'boss+admin@studybuddy.test'],
    ['null', null],
    ['undefined', undefined],
  ])('does not match %s', (_case, input) => {
    process.env.ADMIN_EMAILS = 'boss@studybuddy.test'

    expect(isAdminEmail(input)).toBe(false)
  })

  it('is read per call, not captured at import', () => {
    process.env.ADMIN_EMAILS = 'first@studybuddy.test'
    expect(isAdminEmail('first@studybuddy.test')).toBe(true)

    process.env.ADMIN_EMAILS = 'second@studybuddy.test'
    expect(isAdminEmail('first@studybuddy.test')).toBe(false)
    expect(isAdminEmail('second@studybuddy.test')).toBe(true)
  })
})
