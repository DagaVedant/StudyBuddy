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
import { safeNextPath } from './redirect'

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

function waitFor(seconds: number): string {
  if (seconds < 90) return 'a moment'
  const minutes = Math.ceil(seconds / 60)
  return minutes < 60 ? `${minutes} minutes` : 'an hour'
}

export async function signUp(_prev: FormState, formData: FormData): Promise<FormState> {
  const ip = callerIp(await headers())
  const attempt = await consumeRateLimit(db, SIGNUP_LIMIT, `ip:${ip}`)

  if (!attempt.ok) {
    return {
      error:
        attempt.reason === 'unavailable'
          ? 'Sign-ups are briefly unavailable while we sort something out. Please try again in a minute.'
          : `Too many sign-up attempts from this connection. Try again in ${waitFor(attempt.retryAfter)}.`,
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

  if (isAdminEmail(email)) {
    return { message: 'Your account is ready. Sign in below.' }
  }

  const [existing] = await db
    .select({ id: users.id, emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)

  if (existing) {
    return { message: 'Your account is ready. Sign in below.' }
  }

  const passwordHash = await bcrypt.hash(password, 12)

  await db.insert(users).values({
    email,
    name: name ?? null,
    passwordHash,
    dob: age.dob,
    emailVerified: null,
  })

  return { message: 'Your account is ready. Sign in below.' }
}

export async function signInWithGoogle(): Promise<void> {
  await signIn('google', { redirectTo: '/dashboard' })
}

const SIGNIN_FAILED = 'That email and password combination did not work.'

export async function signInWithCredentials(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase()

  try {
    await signIn('credentials', {
      email,
      password: String(formData.get('password') ?? ''),
      redirectTo: safeNextPath(formData.get('next')),
    })
    return {}
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: SIGNIN_FAILED }
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

