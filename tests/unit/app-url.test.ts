import { afterEach, describe, expect, it } from 'vitest'

import { appBaseUrl, stripTrailingSlashes } from '@/lib/app-url'

const original = process.env.NEXT_PUBLIC_APP_URL

afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = original
})

describe('appBaseUrl', () => {
  // The deployed value is typed into a hosting dashboard, where both forms
  // look right, and the trailing one produced `https://host//verify?token=…`
  // in real verification emails.
  it('drops a trailing slash so a path can be appended safely', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://trystudybuddy.vercel.app/'
    expect(`${appBaseUrl()}/verify`).toBe('https://trystudybuddy.vercel.app/verify')
  })

  it('drops several', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://example.test///'
    expect(appBaseUrl()).toBe('https://example.test')
  })

  it('leaves a clean URL alone', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://example.test'
    expect(appBaseUrl()).toBe('https://example.test')
  })

  it('ignores whitespace pasted in with the value', () => {
    process.env.NEXT_PUBLIC_APP_URL = '  https://example.test/  '
    expect(appBaseUrl()).toBe('https://example.test')
  })

  it('falls back to localhost when unset', () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    expect(appBaseUrl()).toBe('http://localhost:3000')
  })
})

describe('stripTrailingSlashes', () => {
  it('does not eat the slashes in the protocol', () => {
    expect(stripTrailingSlashes('https://example.test')).toBe('https://example.test')
  })
})
