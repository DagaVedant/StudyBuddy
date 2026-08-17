import { describe, expect, it } from 'vitest'

import { isDisposableEmail } from '@/lib/auth/disposable'
import { missingDatabaseUrlIsFatal, shouldSkipBuildMigration } from '@/lib/migrate-guard'
import { selectDriver } from '@/lib/storage'
import { testEndpointsEnabled } from '@/lib/test-endpoints'

describe('testEndpointsEnabled', () => {
  const local = { ENABLE_TEST_ENDPOINTS: 'true' }

  it('answers for a local run that opted in', () => {
    expect(testEndpointsEnabled(local)).toBe(true)
  })

  it('does not care what else is in the environment', () => {
    expect(testEndpointsEnabled({ ...local, VERCEL_ENV: undefined })).toBe(true)
  })

  it('refuses on every deployment, preview included', () => {
    for (const env of ['production', 'preview', 'development']) {
      expect(
        testEndpointsEnabled({ ...local, VERCEL_ENV: env }),
        env,
      ).toBe(false)
    }
  })

  it('refuses when nothing opted in', () => {
    expect(testEndpointsEnabled({})).toBe(false)
    expect(
      testEndpointsEnabled({ ENABLE_TEST_ENDPOINTS: 'false' }),
    ).toBe(false)
    expect(testEndpointsEnabled({ ENABLE_TEST_ENDPOINTS: '1' })).toBe(
      false,
    )
  })
})

describe('selectDriver', () => {
  it('uses blob storage whenever a token is present', () => {
    expect(selectDriver({ BLOB_READ_WRITE_TOKEN: 'x' }).name).toBe(
      'vercel-blob',
    )
  })

  it('uses local disk outside a deployment, which is what tests need', () => {
    expect(selectDriver({}).name).toBe('local')
    expect(selectDriver({ VERCEL_ENV: undefined }).name).toBe('local')
  })

  it('refuses to boot a deployment with nowhere durable to write', () => {
    expect(() => selectDriver({ VERCEL_ENV: 'production' })).toThrow(
      /BLOB_READ_WRITE_TOKEN/,
    )
    expect(() => selectDriver({ VERCEL_ENV: 'preview' })).toThrow()
  })

  it('lets a deployment with a token through', () => {
    expect(
      selectDriver({
        VERCEL_ENV: 'production',
        BLOB_READ_WRITE_TOKEN: 'x',
      }).name,
    ).toBe('vercel-blob')
  })
})

describe('shouldSkipBuildMigration', () => {
  it('migrates a genuinely local build, which has no VERCEL_ENV at all', () => {
    expect(shouldSkipBuildMigration({})).toBe(false)
    expect(shouldSkipBuildMigration({ VERCEL_ENV: undefined })).toBe(false)
  })

  it('skips every Vercel build, preview included, not just production', () => {
    for (const env of ['production', 'preview', 'development']) {
      expect(shouldSkipBuildMigration({ VERCEL_ENV: env }), env).toBe(true)
    }
  })

  it('opts back in when MIGRATE_ON_BUILD is exactly "1"', () => {
    expect(
      shouldSkipBuildMigration({ VERCEL_ENV: 'production', MIGRATE_ON_BUILD: '1' }),
    ).toBe(false)
    expect(
      shouldSkipBuildMigration({ VERCEL_ENV: 'preview', MIGRATE_ON_BUILD: '1' }),
    ).toBe(false)
  })

  it('does not opt in on anything other than exactly "1"', () => {
    expect(
      shouldSkipBuildMigration({ VERCEL_ENV: 'production', MIGRATE_ON_BUILD: 'true' }),
    ).toBe(true)
  })
})

describe('missingDatabaseUrlIsFatal', () => {
  it('is not fatal on a genuinely local build', () => {
    expect(missingDatabaseUrlIsFatal({})).toBe(false)
  })

  it('is fatal on any real Vercel deployment', () => {
    for (const env of ['production', 'preview', 'development']) {
      expect(missingDatabaseUrlIsFatal({ VERCEL_ENV: env }), env).toBe(true)
    }
  })
})

describe('isDisposableEmail', () => {
  it('catches the throwaway inbox services', () => {
    for (const email of [
      'a@mailinator.com',
      'b@guerrillamail.com',
      'c@yopmail.com',
      'd@temp-mail.org',
      'e@10minutemail.com',
    ]) {
      expect(isDisposableEmail(email), email).toBe(true)
    }
  })

  it('catches a subdomain of a listed host', () => {
    expect(isDisposableEmail('x@inbox.mailinator.com')).toBe(true)
    expect(isDisposableEmail('x@a.b.guerrillamail.com')).toBe(true)
  })

  it('is case and whitespace insensitive, since the schema trims after this', () => {
    expect(isDisposableEmail('  X@MAILINATOR.COM  ')).toBe(true)
  })

  it('leaves real addresses alone', () => {
    for (const email of [
      'student@gmail.com',
      'student@school.edu',
      'student@outlook.com',
      'student@protonmail.com',
      'deepakdaga@gmail.com',
    ]) {
      expect(isDisposableEmail(email), email).toBe(false)
    }
  })

  it('does not match a domain that merely contains a listed one', () => {
    expect(isDisposableEmail('x@notmailinator.com')).toBe(false)
    expect(isDisposableEmail('x@mailinator.com.evil.net')).toBe(false)
  })

  it('says nothing about an address it cannot read', () => {
    expect(isDisposableEmail('not-an-email')).toBe(false)
    expect(isDisposableEmail('')).toBe(false)
    expect(isDisposableEmail('@')).toBe(false)
  })
})
