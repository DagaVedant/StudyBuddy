'use server'

import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { headers } from 'next/headers'
import { AuthError } from 'next-auth'

import { auth, signIn } from '@/auth'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { SIGNUP_LIMIT, callerIp, consumeRateLimit } from '@/lib/rate-limit'

import { isDisposableEmail } from './disposable'
import { isAdminEmail, validateDob } from './policy'

export interface FormState {
  error?: string
  message?: string
}

const signupSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('Enter a valid email address.')
    // After .email(), so a malformed address is reported as malformed rather
    // than as a throwaway one.
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
  const attempt = await consumeRateLimit(db, SIGNUP_LIMIT, `ip:${ip}`)

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

  // An admin address is Google-only. A password account cannot prove it owns
  // the address, so it can no longer take the role (see `syncUserClaims`), and
  // allowing the signup anyway would leave a stranger holding the address:
  // the branch below refuses a second signup on it, and Google will not link
  // to an account it did not create. The reply is the one every other outcome
  // gives, so this does not disclose which addresses are admin.
  if (isAdminEmail(email)) {
    return { message: 'Your account is ready. Sign in below.' }
  }

  const [existing] = await db
    .select({ id: users.id, emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)

  if (existing) {
    // Deliberately the same reply as a fresh signup, so this does not report
    // which addresses are registered.
    return { message: 'Your account is ready. Sign in below.' }
  }

  const passwordHash = await bcrypt.hash(password, 12)

  await db.insert(users).values({
    email,
    name: name ?? null,
    passwordHash,
    dob: age.dob,
    // Set on creation because nothing sends mail any more, so there is no
    // link that could ever set it later. Leaving it null would lock the
    // account out of sign-in permanently.
    //
    // This means a password address is unproven: someone can register one
    // they do not own. Google is the recommended way in precisely because it
    // does prove the address, and it is the only path that can.
    emailVerified: new Date(),
  })

  return { message: 'Your account is ready. Sign in below.' }
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

