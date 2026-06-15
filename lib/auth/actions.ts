'use server'

import { randomBytes } from 'node:crypto'

import bcrypt from 'bcryptjs'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

import { AuthError } from 'next-auth'

import { auth, signIn } from '@/auth'
import { db } from '@/lib/db'
import { users, verificationTokens } from '@/lib/db/schema'
import { sendVerificationEmail } from '@/lib/mail'

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

async function issueVerificationToken(email: string) {
  const token = randomBytes(32).toString('hex')

  await db.insert(verificationTokens).values({
    identifier: email,
    token,
    expires: new Date(Date.now() + VERIFICATION_TTL_MS),
  })

  await sendVerificationEmail(email, token)
}

export async function signUp(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = signupSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    name: formData.get('name') || undefined,
    dob: formData.get('dob'),
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' }
  }

  // The 13+ gate (spec §2) — enforced server-side, not just in the date input.
  const age = validateDob(parsed.data.dob)
  if (!age.ok) return { error: age.reason }

  const { email, password, name } = parsed.data

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)

  // Deliberately identical response whether or not the address is taken, so
  // this endpoint can't be used to enumerate accounts.
  if (!existing) {
    const passwordHash = await bcrypt.hash(password, 12)

    await db.insert(users).values({
      email,
      name: name ?? null,
      passwordHash,
      dob: age.dob,
    })

    await issueVerificationToken(email)
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
    // signIn signals success by throwing NEXT_REDIRECT — only AuthError is ours.
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

/**
 * Collects the date of birth for accounts created through OAuth, which never
 * passed through the signup form. The proxy holds these accounts on
 * /onboarding/age until this succeeds.
 */
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
