import { describe, expect, it } from 'vitest'

import { DEFAULT_AFTER_SIGNIN, safeNextPath } from '@/lib/auth/redirect'

describe('safeNextPath', () => {
  it('keeps a path on this site, query and fragment included', () => {
    expect(safeNextPath('/dashboard')).toBe('/dashboard')
    expect(safeNextPath('/worksheets/abc-123/edit')).toBe('/worksheets/abc-123/edit')
    expect(safeNextPath('/topics?tab=weak')).toBe('/topics?tab=weak')
    expect(safeNextPath('/review#card-3')).toBe('/review#card-3')
  })

  
  
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

  
  it('refuses control characters', () => {
    expect(safeNextPath('/dashboard\r\nSet-Cookie: a=b')).toBe(DEFAULT_AFTER_SIGNIN)
    expect(safeNextPath('/dash\u0000board')).toBe(DEFAULT_AFTER_SIGNIN)
    expect(safeNextPath('/dash\u007fboard')).toBe(DEFAULT_AFTER_SIGNIN)
  })

  
  
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

  
  
  it('trims before deciding', () => {
    expect(safeNextPath('  /dashboard  ')).toBe('/dashboard')
    expect(safeNextPath('  https://example.com  ')).toBe(DEFAULT_AFTER_SIGNIN)
  })
})
