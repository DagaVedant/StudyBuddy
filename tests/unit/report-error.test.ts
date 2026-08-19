import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string }[], configured: true }))

vi.mock('@/lib/mail', () => ({
  mailConfigured: () => mail.configured,
  sendMail: async (message: { to: string; subject: string }) => {
    mail.sent.push(message)
  },
}))

const { reportError, resetAlertThrottle } = await import('@/lib/observability/report-error')

const VARIABLES = ['ERROR_WEBHOOK_URL', 'ALERT_EMAIL', 'NEXT_PUBLIC_APP_URL']

beforeEach(() => {
  for (const name of VARIABLES) delete process.env[name]
  mail.sent.length = 0
  mail.configured = true
  resetAlertThrottle()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('reporting a server error', () => {
  it('logs, and tells nobody when nothing is configured', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await reportError({ message: 'boom', path: '/dashboard', method: 'GET' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(mail.sent).toEqual([])
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('GET /dashboard: boom'),
    )
  })

  it('posts to the webhook when one is set', async () => {
    process.env.ERROR_WEBHOOK_URL = 'https://hooks.example.com/abc'
    const fetchMock = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)

    await reportError({ message: 'boom', path: '/upload', method: 'POST' })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://hooks.example.com/abc')
    expect(JSON.parse(String(init.body)).text).toContain('POST /upload: boom')
  })

  it('emails when an address is set, using the mail the app already sends', async () => {
    process.env.ALERT_EMAIL = 'operator@example.com'

    await reportError({ message: 'boom', routeType: 'render' })

    expect(mail.sent).toHaveLength(1)
    expect(mail.sent[0].to).toBe('operator@example.com')
    expect(mail.sent[0].subject).toContain('boom')
  })

  it('says nothing by email when the deployment cannot send email', async () => {
    process.env.ALERT_EMAIL = 'operator@example.com'
    mail.configured = false

    await reportError({ message: 'boom' })

    expect(mail.sent).toEqual([])
  })

  it('repeats the same error at most once every ten minutes', async () => {
    process.env.ALERT_EMAIL = 'operator@example.com'
    const start = 1_000_000

    await reportError({ message: 'same' }, start)
    await reportError({ message: 'same' }, start + 60_000)
    await reportError({ message: 'same' }, start + 9 * 60_000)

    expect(mail.sent).toHaveLength(1)

    await reportError({ message: 'same' }, start + 11 * 60_000)

    expect(mail.sent).toHaveLength(2)
  })

  it('lets a different error through immediately', async () => {
    process.env.ALERT_EMAIL = 'operator@example.com'
    const start = 1_000_000

    await reportError({ message: 'first' }, start)
    await reportError({ message: 'second' }, start + 1000)

    expect(mail.sent).toHaveLength(2)
  })

  it('stops at a dozen an hour, so a bad deploy cannot fill an inbox', async () => {
    process.env.ALERT_EMAIL = 'operator@example.com'
    const start = 1_000_000

    for (let i = 0; i < 40; i += 1) {
      await reportError({ message: `error ${i}` }, start + i * 1000)
    }

    expect(mail.sent).toHaveLength(12)

    await reportError({ message: 'after the hour' }, start + 61 * 60_000)

    expect(mail.sent).toHaveLength(13)
  })

  it('never throws, whatever the channel does', async () => {
    process.env.ERROR_WEBHOOK_URL = 'https://hooks.example.com/abc'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network is down')
      }),
    )

    await expect(reportError({ message: 'boom' })).resolves.toBeUndefined()
  })
})
