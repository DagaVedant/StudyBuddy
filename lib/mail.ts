import {and, desc, eq} from 'drizzle-orm'
import {createTransport} from 'nodemailer'

import {explanations, questions, reports, worksheets} from '@/lib/schema'
import {type Db} from '@/lib/db'

export type MailMessage = {
  to: string
  subject: string
  text: string
}

type MailSender = {
  address: string
  name: string
}

type SmtpSettings = {
  host: string
  port: number
  user: string
  password: string
}

const DEFAULT_HOST = 'smtp.gmail.com'

const DEFAULT_PORT = 465

function trimmedEnv(name: string) {
  const value = process.env[name]
  if (!value) return ''

  return value.trim()
}

function mailSender(): MailSender | null {
  const address = trimmedEnv('MAIL_FROM')
  if (!address) return null

  let name = trimmedEnv('MAIL_FROM_NAME')
  if (!name) name = 'StudyBuddy'

  return {address, name}
}

function smtpSettings(): SmtpSettings | null {
  const password = trimmedEnv('SMTP_PASSWORD')

  let user = trimmedEnv('SMTP_USER')

  if (!user) {
    const sender = mailSender()
    if (sender) user = sender.address
  }

  if (!password || !user) return null

  let port = DEFAULT_PORT

  const rawPort = trimmedEnv('SMTP_PORT')
  if (rawPort) {
    const parsed = Number(rawPort)
    if (Number.isFinite(parsed)) port = parsed
  }

  let host = trimmedEnv('SMTP_HOST')
  if (!host) host = DEFAULT_HOST

  return {host, port, user, password}
}

export function mailConfigured() {
  if (!mailSender()) return false
  if (!smtpSettings()) return false

  return true
}

const TIMEOUT_MS = 15000

async function sendOverSmtp(
  settings: SmtpSettings,
  sender: MailSender,
  message: MailMessage,
) {
  const transport = createTransport({
    host: settings.host,
    port: settings.port,

    secure: settings.port === 465,
    requireTLS: settings.port !== 465,

    auth: {user: settings.user, pass: settings.password},

    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  })

  try {
    await transport.sendMail({
      from: {address: sender.address, name: sender.name},
      to: message.to,
      subject: message.subject,
      text: message.text,
    })
  } finally {
    transport.close()
  }
}

export async function sendMail(message: MailMessage) {
  const sender = mailSender()
  const settings = smtpSettings()

  if (!sender || !settings) {
    console.warn(
      '[mail] not configured, so nothing was sent to ' +
        message.to +
        '. Set MAIL_FROM and SMTP_PASSWORD.',
    )
    return
  }

  await sendOverSmtp(settings, sender, message)
}

export type ErrorReport = {
  message: string
  digest?: string
  path?: string
  method?: string
  routeType?: string
}

const REPORT_TIMEOUT_MS = 5000

const REPEAT_WINDOW_MS = 10 * 60000

const MAX_PER_HOUR = 12

const HOUR_MS = 3600000

const lastSeen = new Map<string, number>()
let windowStartedAt = 0
let sentThisWindow = 0

function shouldSend(key: string) {
  const now = Date.now()

  if (now - windowStartedAt > HOUR_MS) {
    windowStartedAt = now
    sentThisWindow = 0
  }

  if (sentThisWindow >= MAX_PER_HOUR) return false

  const seen = lastSeen.get(key)
  if (seen !== undefined && now - seen < REPEAT_WINDOW_MS) return false

  lastSeen.set(key, now)
  sentThisWindow = sentThisWindow + 1

  return true
}

function describe(report: ErrorReport) {
  const parts = []
  if (report.method) parts.push(report.method)
  if (report.path) parts.push(report.path)

  let where = parts.join(' ')
  if (!where && report.routeType) where = report.routeType
  if (!where) where = 'server'

  let digest = ''
  if (report.digest) digest = ' (digest ' + report.digest + ')'

  return where + ': ' + report.message + digest
}

export async function reportError(report: ErrorReport) {
  const line = describe(report)

  console.error('[error] ' + line)

  const url = trimmedEnv('ERROR_WEBHOOK_URL')
  const alertTo = trimmedEnv('ALERT_EMAIL')

  if (!url && !alertTo) return
  if (!shouldSend(report.message)) return

  let site = trimmedEnv('NEXT_PUBLIC_APP_URL')
  if (!site) site = 'studybuddy'

  const body = 'StudyBuddy error on ' + site + '\n' + line

  if (url) {
    try {
      await fetch(url, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({text: body}),
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      })
    } catch (cause) {
      console.error('[error] could not post the report:', (cause as Error).message)
    }
  }

  if (alertTo && mailConfigured()) {
    try {
      await sendMail({
        to: alertTo,
        subject: 'StudyBuddy error: ' + report.message.slice(0, 80),
        text:
          body +
          '\n\nThis is capped at one repeat every ten minutes and a dozen an hour.',
      })
    } catch (cause) {
      console.error('[error] could not email the report:', (cause as Error).message)
    }
  }
}

export type ReportInput = {
  kind: string
  worksheetId?: string
  questionId?: string
  message?: string | null
}

export type ReportResult = {
  ok: boolean
  reportId: string | null
  reason: string
}

export async function recordReport(
  db: Db,
  userId: string,
  input: ReportInput,
): Promise<ReportResult> {
  let message: string | null = null
  if (input.message && input.message.trim()) message = input.message.trim()

  if (input.kind === 'worksheet') {
    let worksheetId = ''
    if (input.worksheetId) worksheetId = input.worksheetId

    const [worksheet] = await db
      .select({id: worksheets.id})
      .from(worksheets)
      .where(and(eq(worksheets.id, worksheetId), eq(worksheets.userId, userId)))
      .limit(1)

    if (!worksheet) return {ok: false, reportId: null, reason: 'not_found'}

    const [row] = await db
      .insert(reports)
      .values({userId, kind: 'worksheet', worksheetId: worksheet.id, message})
      .returning({id: reports.id})

    return {ok: true, reportId: row.id, reason: ''}
  }

  let questionId = ''
  if (input.questionId) questionId = input.questionId

  const [question] = await db
    .select({id: questions.id, worksheetId: questions.worksheetId})
    .from(questions)
    .where(and(eq(questions.id, questionId), eq(questions.userId, userId)))
    .limit(1)

  if (!question) return {ok: false, reportId: null, reason: 'not_found'}

  const [explanation] = await db
    .select({id: explanations.id})
    .from(explanations)
    .where(eq(explanations.questionId, question.id))
    .orderBy(desc(explanations.generatedAt))
    .limit(1)

  if (!explanation) return {ok: false, reportId: null, reason: 'nothing_to_report'}

  await db
    .update(explanations)
    .set({reportedWrong: true})
    .where(eq(explanations.id, explanation.id))

  const [row] = await db
    .insert(reports)
    .values({
      userId,
      kind: 'explanation',
      worksheetId: question.worksheetId,
      questionId: question.id,
      explanationId: explanation.id,
      message,
    })
    .returning({id: reports.id})

  return {ok: true, reportId: row.id, reason: ''}
}
