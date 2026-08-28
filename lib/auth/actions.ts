'use server'

import bcrypt from 'bcryptjs'
import {eq} from 'drizzle-orm'
import {z} from 'zod'

import {headers} from 'next/headers'
import {AuthError} from 'next-auth'

import {auth, signIn} from '@/auth'
import {db} from '@/lib/db'
import {users} from '@/lib/schema'
import {mailConfigured, sendMail} from '@/lib/mail'
import {
  RESET_ATTEMPT_LIMIT,
  RESET_REQUEST_EMAIL_LIMIT,
  RESET_REQUEST_IP_LIMIT,
  SIGNUP_LIMIT,
  callerIp,
  consumeRateLimit,
} from '@/lib/api'

import {
  canonicalEmail,
  isAdminEmail,
  isDisposableEmail,
  safeNextPath,
  validateDob,
} from './policy'
import {
  consumeResetToken,
  emailTwinExists,
  findResetTarget,
  inviteAccepted,
  inviteRequired,
  issueResetToken,
  resetLink,
} from './identity'

export type FormState = {
  error?: string
  message?: string
}

const signupSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('Enter a valid email address.')
    .refine((email) => !isDisposableEmail(email), {
      message: 'Use an email address you will still have later, not a temporary one.',
    }),
  password: z
    .string()
    .min(10, 'Use at least 10 characters.')
    .max(200, 'That password is too long.'),
  name: z.string().trim().max(100).optional(),
  dob: z.string().min(1, 'Enter your date of birth.'),
})

function waitFor(seconds: number) {
  if (seconds < 90) return 'a moment'

  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return minutes + ' minutes'

  return 'an hour'
}

function firstIssue(error: z.ZodError) {
  const issue = error.issues[0]
  if (issue && issue.message) return issue.message

  return 'Check the form and try again.'
}

function textField(formData: FormData, name: string) {
  const value = formData.get(name)
  if (typeof value !== 'string') return ''

  return value
}

export async function signUp(_prev: FormState, formData: FormData): Promise<FormState> {
  const ip = callerIp(await headers())
  const attempt = await consumeRateLimit(db, SIGNUP_LIMIT, 'ip:' + ip)

  if (!attempt.ok) {
    if (attempt.reason === 'unavailable') {
      return {
        error:
          'Sign-ups are briefly unavailable while we sort something out. Please try again in a minute.',
      }
    }

    return {
      error:
        'Too many sign-up attempts from this connection. Try again in ' +
        waitFor(attempt.retryAfter) +
        '.',
    }
  }

  if (inviteRequired() && !inviteAccepted(textField(formData, 'invite'))) {
    return {error: 'That invite code is not right. Ask whoever sent you here.'}
  }

  let name = formData.get('name')
  if (!name) name = null

  const parsed = signupSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    name: name === null ? undefined : name,
    dob: formData.get('dob'),
  })

  if (!parsed.success) return {error: firstIssue(parsed.error)}

  const age = validateDob(parsed.data.dob)
  if (!age.ok || !age.dob) return {error: age.reason}

  const email = parsed.data.email
  const password = parsed.data.password

  let displayName: string | null = null
  if (parsed.data.name) displayName = parsed.data.name

  if (isAdminEmail(email)) {
    return {message: 'Your account is ready. Sign in below.'}
  }

  if (await emailTwinExists(db, canonicalEmail(email))) {
    return {message: 'Your account is ready. Sign in below.'}
  }

  const passwordHash = await bcrypt.hash(password, 12)

  await db.insert(users).values({
    email,
    name: displayName,
    passwordHash,
    dob: age.dob,
    emailVerified: null,
  })

  return {message: 'Your account is ready. Sign in below.'}
}

const SIGNIN_FAILED = 'That email and password combination did not work.'

export async function signInWithCredentials(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const email = textField(formData, 'email').trim().toLowerCase()

  try {
    await signIn('credentials', {
      email,
      password: textField(formData, 'password'),
      redirectTo: safeNextPath(formData.get('next')),
    })

    return {}
  } catch (error) {
    if (error instanceof AuthError) return {error: SIGNIN_FAILED}

    throw error
  }
}

const SENT =
  'If that address has an account, a link to set a password is on its way. It works once, and for an hour.'

const NO_MAIL =
  'This deployment cannot send email, so there is no password reset. Ask whoever runs it.'

export async function requestPasswordReset(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!mailConfigured()) return {error: NO_MAIL}

  const email = textField(formData, 'email').trim().toLowerCase()

  const ip = callerIp(await headers())
  const byIp = await consumeRateLimit(db, RESET_REQUEST_IP_LIMIT, 'ip:' + ip)

  if (!byIp.ok) {
    return {
      error:
        'Too many reset requests from this connection. Try again in ' +
        waitFor(byIp.retryAfter) +
        '.',
    }
  }

  if (!z.string().email().safeParse(email).success) {
    return {error: 'Enter a valid email address.'}
  }

  const byEmail = await consumeRateLimit(db, RESET_REQUEST_EMAIL_LIMIT, 'email:' + email)
  if (!byEmail.ok) return {message: SENT}

  const [user] = await db
    .select({id: users.id})
    .from(users)
    .where(eq(users.email, email))
    .limit(1)

  if (!user) return {message: SENT}

  const token = await issueResetToken(db, user.id)

  try {
    await sendMail({
      to: email,
      subject: 'Set your StudyBuddy password',
      text:
        'Open this link to set a password:\n\n' +
        resetLink(token) +
        '\n\nIt works once, and stops working in an hour. ' +
        'If you did not ask for it, nothing has changed and you can ignore this.',
    })
  } catch (error) {
    console.error('[auth] could not send a reset link:', (error as Error).message)

    return {error: 'We could not send that email just now. Try again in a few minutes.'}
  }

  return {message: SENT}
}

const resetSchema = z.object({
  token: z.string().min(1),
  password: z
    .string()
    .min(10, 'Use at least 10 characters.')
    .max(200, 'That password is too long.'),
})

const DEAD_LINK =
  'That link has expired or has already been used. Ask for a new one below.'

export async function resetPassword(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const ip = callerIp(await headers())
  const attempt = await consumeRateLimit(db, RESET_ATTEMPT_LIMIT, 'ip:' + ip)

  if (!attempt.ok) {
    return {
      error:
        'Too many attempts from this connection. Try again in ' +
        waitFor(attempt.retryAfter) +
        '.',
    }
  }

  const parsed = resetSchema.safeParse({
    token: formData.get('token'),
    password: formData.get('password'),
  })

  if (!parsed.success) return {error: firstIssue(parsed.error)}

  const target = await findResetTarget(db, parsed.data.token)
  if (!target) return {error: DEAD_LINK}

  const passwordHash = await bcrypt.hash(parsed.data.password, 12)

  await consumeResetToken(db, target, passwordHash)

  return {message: 'Your password is set. Sign in with it below.'}
}

export async function submitDob(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await auth()
  if (!session || !session.user || !session.user.id) {
    return {error: 'You need to be signed in.'}
  }

  const age = validateDob(formData.get('dob') as string | null)
  if (!age.ok || !age.dob) return {error: age.reason}

  await db.update(users).set({dob: age.dob}).where(eq(users.id, session.user.id))

  return {message: 'Saved.'}
}

export async function acceptTerms(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await auth()
  if (!session || !session.user || !session.user.id) {
    return {error: 'You need to be signed in.'}
  }

  if (formData.get('agree') !== 'on') {
    return {error: 'Check the box to confirm before continuing.'}
  }

  await db
    .update(users)
    .set({termsAcceptedAt: new Date()})
    .where(eq(users.id, session.user.id))

  return {message: 'Saved.'}
}
