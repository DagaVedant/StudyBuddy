import { beforeEach, describe, expect, it, vi } from 'vitest'

const sent = vi.hoisted(() => ({
  transports: [] as Record<string, unknown>[],
  messages: [] as Record<string, unknown>[],
  closed: 0,
  fail: null as Error | null,
}))

vi.mock('nodemailer', () => ({
  createTransport: (options: Record<string, unknown>) => {
    sent.transports.push(options)

    return {
      sendMail: async (message: Record<string, unknown>) => {
        if (sent.fail) throw sent.fail
        sent.messages.push(message)
        return { messageId: 'test' }
      },
      close: () => {
        sent.closed += 1
      },
    }
  },
}))

const { mailConfigured, mailSender, sendMail, smtpSettings } = await import('@/lib/mail')

const VARIABLES = [
  'MAIL_FROM',
  'MAIL_FROM_NAME',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASSWORD',
]

function configure(): void {
  process.env.MAIL_FROM = 'studybuddy@example.com'
  process.env.SMTP_PASSWORD = 'app-password'
}

beforeEach(() => {
  for (const name of VARIABLES) delete process.env[name]

  sent.transports.length = 0
  sent.messages.length = 0
  sent.closed = 0
  sent.fail = null
})

describe('whether this deployment can send email at all', () => {
  it('is false with a password but no sender address', () => {
    process.env.SMTP_PASSWORD = 'app-password'

    expect(mailConfigured()).toBe(false)
  })

  it('is false with an address but no password', () => {
    process.env.MAIL_FROM = 'studybuddy@example.com'

    expect(mailConfigured()).toBe(false)
  })

  it('is true on those two alone', () => {
    configure()

    expect(mailConfigured()).toBe(true)
    expect(mailSender()).toEqual({
      address: 'studybuddy@example.com',
      name: 'StudyBuddy',
    })
  })
})

describe('the SMTP settings', () => {
  it('point at Gmail over implicit TLS, signing in as the sender', () => {
    configure()

    expect(smtpSettings()).toEqual({
      host: 'smtp.gmail.com',
      port: 465,
      user: 'studybuddy@example.com',
      password: 'app-password',
    })
  })

  it('take another host, port and user when one is given', () => {
    configure()
    process.env.SMTP_HOST = 'smtp.fastmail.com'
    process.env.SMTP_PORT = '587'
    process.env.SMTP_USER = 'someone-else@example.com'

    expect(smtpSettings()).toMatchObject({
      host: 'smtp.fastmail.com',
      port: 587,
      user: 'someone-else@example.com',
    })
  })

  it('fall back to the default port rather than NaN', () => {
    configure()
    process.env.SMTP_PORT = 'not-a-port'

    expect(smtpSettings()?.port).toBe(465)
  })
})

describe('sending', () => {
  it('hands the message to the transport and closes it', async () => {
    configure()

    await sendMail({ to: 'student@example.com', subject: 'Hello', text: 'A link.' })

    expect(sent.transports[0]).toMatchObject({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: 'studybuddy@example.com', pass: 'app-password' },
    })

    expect(sent.messages[0]).toMatchObject({
      from: { address: 'studybuddy@example.com', name: 'StudyBuddy' },
      to: 'student@example.com',
      subject: 'Hello',
      text: 'A link.',
    })

    expect(sent.closed).toBe(1)
  })

  it('demands TLS on a port that does not start with it', async () => {
    configure()
    process.env.SMTP_PORT = '587'

    await sendMail({ to: 'student@example.com', subject: 'Hello', text: 'A link.' })

    expect(sent.transports[0]).toMatchObject({ secure: false, requireTLS: true })
  })

  it('throws when the host refuses, and still closes the transport', async () => {
    configure()
    sent.fail = new Error('535 Username and Password not accepted')

    await expect(
      sendMail({ to: 'student@example.com', subject: 'Hello', text: 'A link.' }),
    ).rejects.toThrow(/535/)

    expect(sent.closed).toBe(1)
  })

  it('sends nothing, and does not throw, when nothing is configured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await sendMail({ to: 'student@example.com', subject: 'Hello', text: 'A link.' })

    expect(sent.transports).toHaveLength(0)
    expect(warn).toHaveBeenCalled()

    warn.mockRestore()
  })
})
