'use server'

import { randomBytes } from 'node:crypto'

import bcrypt from 'bcryptjs'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

import { headers } from 'next/headers'
import { AuthError } from 'next-auth'

import { auth, signIn } from '@/auth'
import type { Db } from '@/lib/dashboard/queries'
import { db } from '@/lib/db'
import { users, verificationTokens } from '@/lib/db/schema'
import { sendVerificationEmail } from '@/lib/mail'
import {
  SIGNUP_LIMIT,
  VERIFY_EMAIL_LIMIT,
  callerIp,
  consumeRateLimit,
} from '@/lib/rate-limit'

import { validateDob } from './policy'

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000

export interface FormState {
  error?: string
  message?: string
}

const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  password: z
    .string()
    .min(10, 'Use at least 10 characters.')
    .max(200, 'That password is too long.'),
  name: z.string().trim().max(100).optional(),
  dob: z.string().min(1, 'Enter your date of birth.'),
})

/**
 * Issues a fresh verification link, unless this address has had too many.
 *
 * Keyed by address as well as by caller: the signup limit caps one connection,
 * but sending mail to an address the requester does not own is the abuse worth
 * stopping, and that can be driven from anywhere.
 *
 * Returns false when throttled rather than throwing, because the account is
 * fine and the last link it was sent still works.
 */
async function issueVerificationToken(email: string): Promise<boolean> {
  const allowance = await consumeRateLimit(
    db as unknown as Db,
    VERIFY_EMAIL_LIMIT,
    `email:${email}`,
  )
  if (!allowance.ok) return false

  const token = randomBytes(32).toString('hex')

  // Old links for this address are dropped first, so a retry leaves exactly
  // one working link rather than a pile of them.
  await db.delete(verificationTokens).where(eq(verificationTokens.identifier, email))

  await db.insert(verificationTokens).values({
    identifier: email,
    token,
    expires: new Date(Date.now() + VERIFICATION_TTL_MS),
  })

  await sendVerificationEmail(email, token)
  return true
}

/**
 * Says how long to wait, without pretending a minute is "60 minutes".
 */
function waitFor(seconds: number): string {
  if (seconds < 90) return 'a moment'
  const minutes = Math.ceil(seconds / 60)
  return minutes < 60 ? `${minutes} minutes` : 'an hour'
}

export async function signUp(_prev: FormState, formData: FormData): Promise<FormState> {
  // Checked before the form is even read: the point is to cap how often this
  // runs at all, and parsing first would let a flood of junk through to the
  // database lookups below.
  const ip = callerIp(await headers())
  const attempt = await consumeRateLimit(db as unknown as Db, SIGNUP_LIMIT, `ip:${ip}`)

  if (!attempt.ok) {
    return {
      error: `Too many sign-up attempts from this connection. Try again in ${waitFor(attempt.retryAfter)}.`,
    }
  }

  const parsed = signupSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    name: formData.get('name') || undefined,
    dob: formData.get('dob'),
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' }
  }

  const age = validateDob(parsed.data.dob)
  if (!age.ok) return { error: age.reason }

  const { email, password, name } = parsed.data

  const [existing] = await db
    .select({ id: users.id, emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)

  if (!existing) {
    const passwordHash = await bcrypt.hash(password, 12)

    await db.insert(users).values({
      email,
      name: name ?? null,
      passwordHash,
      dob: age.dob,
    })
  }

  // Signing up again for an address that exists but was never verified
  // re-sends the link. Without this, anyone whose first email failed to
  // arrive was stuck for good: the account already existed, so a second
  // attempt issued nothing and still claimed a link was on its way.
  const needsLink = !existing || !existing.emailVerified

  if (needsLink) {
    try {
      const sent = await issueVerificationToken(email)

      // The reply below stays the same either way. Saying "you have had too
      // many links" would confirm the address is registered, which is exactly
      // what the neutral wording exists to avoid — and the last link this
      // address was sent is still valid, so nothing is actually lost.
      if (!sent) {
        console.warn(`[signup] verification email throttled for ${email}`)
      }
    } catch (cause) {
      console.error('[signup] could not send verification email:', cause)

      // Said the same way whether the account is new or already pending, so
      // this still does not reveal whether the address is registered.
      return {
        error:
          'Your account is ready, but the verification email could not be sent. Try signing up again in a moment to get a new link.',
      }
    }
  }

  return {
    message: `If ${email} isn't already registered, a verification link is on its way.`,
  }
}

export async function signInWithGoogle(): Promise<void> {
  await signIn('google', { redirectTo: '/dashboard' })
}

export async function signInWithCredentials(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    await signIn('credentials', {
      email: String(formData.get('email') ?? ''),
      password: String(formData.get('password') ?? ''),
      redirectTo: String(formData.get('next') || '/dashboard'),
    })
    return {}
  } catch (error) {
    if (error instanceof AuthError) {
      const cause = error.cause?.err?.message
      if (cause === 'EmailNotVerified') {
        return { error: 'Verify your email address before signing in.' }
      }
      return { error: 'That email and password combination did not work.' }
    }
    throw error
  }
}

export async function submitDob(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await auth()
  if (!session?.user?.id) return { error: 'You need to be signed in.' }

  const age = validateDob(formData.get('dob') as string | null)
  if (!age.ok) return { error: age.reason }

  await db.update(users).set({ dob: age.dob }).where(eq(users.id, session.user.id))

  return { message: 'Saved.' }
}

export async function verifyEmail(email: string, token: string): Promise<boolean> {
  const [row] = await db
    .select()
    .from(verificationTokens)
    .where(
      and(
        eq(verificationTokens.identifier, email),
        eq(verificationTokens.token, token),
      ),
    )
    .limit(1)

  if (!row) return false

  await db
    .delete(verificationTokens)
    .where(
      and(
        eq(verificationTokens.identifier, email),
        eq(verificationTokens.token, token),
      ),
    )

  if (row.expires.getTime() < Date.now()) return false

  await db.update(users).set({ emailVerified: new Date() }).where(eq(users.email, email))

  return true
}
