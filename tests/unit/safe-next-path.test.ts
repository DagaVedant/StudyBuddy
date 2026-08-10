import { describe, expect, it } from 'vitest'

import { DEFAULT_AFTER_SIGNIN, safeNextPath } from '@/lib/auth/redirect'

/**
 * `signInWithCredentials` passed the raw `next` form field to `redirectTo`, so
 * `/signin?next=https://example.com` walked the student off the site the moment
 * they authenticated, having just typed a password. Every case below is a way
 * of spelling "somewhere else" that a `startsWith('/')` check would have let
 * through.
 */
describe('safeNextPath', () => {
  it('keeps a path on this site, query and fragment included', () => {
    expect(safeNextPath('/dashboard')).toBe('/dashboard')
    expect(safeNextPath('/worksheets/abc-123/review')).toBe('/worksheets/abc-123/review')
    expect(safeNextPath('/topics?tab=weak')).toBe('/topics?tab=weak')
    expect(safeNextPath('/review#card-3')).toBe('/review#card-3')
  })

  // The hyphen case, which a sloppy control-character class would eat. Every
  // worksheet id in this app contains them.
  it('keeps hyphens, which every worksheet id has', () => {
    expect(safeNextPath('/worksheets/4f2a9c1e-0b77-4c3d-9a11-5e6f7a8b9c0d/markup')).toBe(
      '/worksheets/4f2a9c1e-0b77-4c3d-9a11-5e6f7a8b9c0d/markup',
    )
  })

  it('refuses an absolute URL', () => {
    for (const value of [
      'https://example.com',
      'http://example.com/steal',
      'HTTPS://EXAMPLE.COM',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
    ]) {
      expect(safeNextPath(value), value).toBe(DEFAULT_AFTER_SIGNIN)
    }
  })

  // The one a leading-slash check waves through. `//example.com` is
  // protocol-relative and browsers read it as a host, not a path.
  it('refuses a protocol-relative URL, in either slash direction', () => {
    for (const value of [
      '//example.com',
      '//example.com/path',
      '/\\example.com',
      '/\\/example.com',
      '\\\\example.com',
    ]) {
      expect(safeNextPath(value), value).toBe(DEFAULT_AFTER_SIGNIN)
    }
  })

  it('refuses a backslash anywhere, which parsers disagree about', () => {
    expect(safeNextPath('/dashboard\\@example.com')).toBe(DEFAULT_AFTER_SIGNIN)
    expect(safeNextPath('/a\\b')).toBe(DEFAULT_AFTER_SIGNIN)
  })

  // A CR or LF in a Location header is how response splitting is spelled.
  it('refuses control characters', () => {
    expect(safeNextPath('/dashboard\r\nSet-Cookie: a=b')).toBe(DEFAULT_AFTER_SIGNIN)
    expect(safeNextPath('/dash\u0000board')).toBe(DEFAULT_AFTER_SIGNIN)
    expect(safeNextPath('/dash\u007fboard')).toBe(DEFAULT_AFTER_SIGNIN)
  })

  // A space is not a control character, and URL() percent-encodes it rather
  // than refusing. That is right: the path is still on this origin.
  it('encodes a space rather than discarding the path', () => {
    expect(safeNextPath('/topics/ratios and rates')).toBe('/topics/ratios%20and%20rates')
  })

  it('refuses anything that is not a string, and anything relative', () => {
    for (const value of [null, undefined, 42, {}, [], 'dashboard', '../admin', '']) {
      expect(safeNextPath(value), String(value)).toBe(DEFAULT_AFTER_SIGNIN)
    }
  })

  it('takes a caller-supplied fallback', () => {
    expect(safeNextPath('https://example.com', '/upload')).toBe('/upload')
  })

  // Whitespace padding is not a reason to refuse a legitimate path, and is a
  // way to sneak past a naive prefix test.
  it('trims before deciding', () => {
    expect(safeNextPath('  /dashboard  ')).toBe('/dashboard')
    expect(safeNextPath('  https://example.com  ')).toBe(DEFAULT_AFTER_SIGNIN)
  })
})
