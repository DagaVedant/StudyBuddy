import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mailConfigured, mailSender, sendMail } from '@/lib/mail'

const KEY = 'BREVO_API_KEY'

function configure(): void {
  process.env.MAIL_FROM = 'studybuddy@example.com'
  process.env.MAIL_FROM_NAME = 'StudyBuddy'
  process.env[KEY] = 'xkeysib-test'
}

beforeEach(() => {
  delete process.env.MAIL_FROM
  delete process.env.MAIL_FROM_NAME
  delete process.env[KEY]
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('whether this deployment can send email at all', () => {
  it('is false with no sender address', () => {
    process.env[KEY] = 'xkeysib-test'

    expect(mailConfigured()).toBe(false)
  })

  it('is false with an address but no key', () => {
    process.env.MAIL_FROM = 'studybuddy@example.com'

    expect(mailConfigured()).toBe(false)
  })

  it('is true once both are set', () => {
    configure()

    expect(mailConfigured()).toBe(true)
    expect(mailSender()).toEqual({
      address: 'studybuddy@example.com',
      name: 'StudyBuddy',
    })
  })

  it('names the product when nobody named the sender', () => {
    process.env.MAIL_FROM = 'studybuddy@example.com'

    expect(mailSender()?.name).toBe('StudyBuddy')
  })
})

describe('sending', () => {
  it('posts the message to Brevo', async () => {
    configure()

    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    await sendMail({ to: 'student@example.com', subject: 'Hello', text: 'A link.' })

    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]

    expect(url).toBe('https://api.brevo.com/v3/smtp/email')
    expect((init.headers as Record<string, string>)['api-key']).toBe('xkeysib-test')
    expect(JSON.parse(String(init.body))).toMatchObject({
      sender: { email: 'studybuddy@example.com', name: 'StudyBuddy' },
      to: [{ email: 'student@example.com' }],
      subject: 'Hello',
      textContent: 'A link.',
    })
  })

  it('throws when Brevo refuses, so the caller can say so', async () => {
    configure()

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('sender not verified', { status: 400 })),
    )

    await expect(
      sendMail({ to: 'student@example.com', subject: 'Hello', text: 'A link.' }),
    ).rejects.toThrow(/400/)
  })

  it('sends nothing, and does not throw, when nothing is configured', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await sendMail({ to: 'student@example.com', subject: 'Hello', text: 'A link.' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()

    warn.mockRestore()
  })
})
