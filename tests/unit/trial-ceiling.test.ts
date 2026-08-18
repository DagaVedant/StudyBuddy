import { afterEach, describe, expect, it } from 'vitest'

import { trialDailyCeiling } from '@/lib/ai/limits'

afterEach(() => {
  delete process.env.TRIAL_DAILY_WORKSHEETS
})

describe('the daily ceiling on trial extractions', () => {
  it('defaults to something the operator can afford', () => {
    expect(trialDailyCeiling()).toBe(25)
  })

  it('takes a number', () => {
    process.env.TRIAL_DAILY_WORKSHEETS = '5'
    expect(trialDailyCeiling()).toBe(5)
  })

  it('takes zero, which closes the trial rather than being ignored', () => {
    process.env.TRIAL_DAILY_WORKSHEETS = '0'
    expect(trialDailyCeiling()).toBe(0)
  })

  it('takes the word unlimited', () => {
    process.env.TRIAL_DAILY_WORKSHEETS = 'unlimited'
    expect(trialDailyCeiling()).toBe(Number.POSITIVE_INFINITY)
  })

  it('falls back rather than trusting nonsense', () => {
    process.env.TRIAL_DAILY_WORKSHEETS = 'plenty'
    expect(trialDailyCeiling()).toBe(25)

    process.env.TRIAL_DAILY_WORKSHEETS = '-4'
    expect(trialDailyCeiling()).toBe(25)
  })
})
