import { describe, expect, it } from 'vitest'

import { isDisposableEmail } from '@/lib/auth/disposable'
import { selectDriver } from '@/lib/storage'
import { testEndpointsEnabled } from '@/lib/test-endpoints'

/**
 * The e2e suite runs `next build && npx next start` (playwright.config.ts:44),
 * so its server reports NODE_ENV=production as loudly as the deployed one does.
 * Both guards below therefore key on VERCEL_ENV instead. These tests exist
 * because the obvious NODE_ENV version of each would pass review, ship, and
 * break all 41 e2e tests.
 */
describe('testEndpointsEnabled', () => {
  const local = { ENABLE_TEST_ENDPOINTS: 'true' }

  it('answers for a local run that opted in', () => {
    expect(testEndpointsEnabled(local)).toBe(true)
  })

  // The e2e suite's server runs a production build, so a NODE_ENV-based guard
  // would refuse it. Both guards take only the keys they read, so NODE_ENV is
  // not reachable from here: that is now a compile error rather than a test,
  // which is the stronger version of this assertion.
  it('does not care what else is in the environment', () => {
    expect(testEndpointsEnabled({ ...local, VERCEL_ENV: undefined })).toBe(true)
  })

  // These routes mint an admin account with no session and no CSRF token.
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
    // Exactly "true", so a stray "1" does not open them.
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

  // The failure this replaces was silent: uploads accepted, then "Page image
  // missing" when the worker came for them, because .uploads does not survive
  // the invocation that wrote it.
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

  // Several of these hand out unlimited subdomains, which is the whole point of
  // matching on the suffix rather than the exact host.
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

  // A domain that merely ends in the same letters is not the same domain. The
  // suffix match walks label boundaries, so this cannot pass.
  it('does not match a domain that merely contains a listed one', () => {
    expect(isDisposableEmail('x@notmailinator.com')).toBe(false)
    expect(isDisposableEmail('x@mailinator.com.evil.net')).toBe(false)
  })

  // Rejecting a malformed address is the schema's job; doing it here too would
  // report the wrong reason to whoever typed it.
  it('says nothing about an address it cannot read', () => {
    expect(isDisposableEmail('not-an-email')).toBe(false)
    expect(isDisposableEmail('')).toBe(false)
    expect(isDisposableEmail('@')).toBe(false)
  })
})
