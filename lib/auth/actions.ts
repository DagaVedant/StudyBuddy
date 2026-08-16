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
    // Two different refusals wearing one sentence. `unavailable` means the
    // counter could not be read, not that this person has been trying: signup
    // is the one rule that fails closed, so a first-time student meets this
    // having made no attempts at all, and blaming them for it would be a lie
    // told to cover a database problem.
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
    /*
     * Left null, because it is not verified.
     *
     * This used to stamp `new Date()` on creation, justified by "leaving it
     * null would lock the account out of sign-in permanently". That is not
     * true and can be read in `auth.ts`: `authorize` checks the password hash
     * and bcrypt, and never looks at this column. Nothing gated sign-in on it,
     * so the stamp bought nothing and cost the column its meaning.
     *
     * What it cost is not abstract. `auth.ts` and `lib/auth/admin.ts` both
     * record finding the same thing: admin used to require a verified email,
     * which was true for every credentials account precisely because of this
     * line, so the check collapsed into "is this address in the list". Two
     * places had already routed around a column that lied rather than fixing
     * the line that made it lie.
     *
     * Null now means what it says. Google sign-in sets it when Google reports
     * the address verified (auth.ts:157-166), so non-null is a fact rather
     * than a formality, and the trial being tied to an unproven address is at
     * least legible to anything that ever wants to act on it.
     */
    emailVerified: null,
  })

  return { message: 'Your account is ready. Sign in below.' }
}

export async function signInWithGoogle(): Promise<void> {
  await signIn('google', { redirectTo: '/dashboard' })
}

/**
 * One message for every way sign-in can fail.
 *
 * A throttled attempt reads the same as a wrong password on purpose. Saying
 * "too many attempts" confirms the address exists and tells a guesser exactly
 * when to come back; saying nothing costs a real person nothing, because a real
 * person is not on their twentieth attempt this hour.
 */
const SIGNIN_FAILED = 'That email and password combination did not work.'

export async function signInWithCredentials(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase()

  /*
   * The throttle for this lives in `authorize` now, not here.
   *
   * It guarded the form and only the form. Auth.js serves its own credentials
   * callback at /api/auth/callback/credentials, which reaches the same bcrypt
   * compare without passing through this action at all, so the limit was one
   * door of two. Both doors go through `authorize`, which is where it is.
   *
   * A throttled attempt fails there and comes back as the AuthError below, so
   * the reader still sees SIGNIN_FAILED and still cannot tell a throttle from
   * a wrong password.
   */
  try {
    await signIn('credentials', {
      email,
      password: String(formData.get('password') ?? ''),
      // Validated rather than passed through: this used to take the raw form
      // field, so `/signin?next=https://example.com` walked the student off the
      // site the instant they authenticated.
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

