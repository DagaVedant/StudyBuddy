'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useActionState } from 'react'

import { signInWithCredentials, signInWithGoogle } from '@/lib/auth/actions'
import type { FormState } from '@/lib/auth/actions'

const ERRORS: Record<string, string> = {
  InvalidVerificationLink: 'That verification link is not valid.',
  VerificationExpired: 'That verification link has expired. Sign up again to get a new one.',
  OAuthAccountNotLinked: 'That email is already registered with a password. Sign in with your password instead.',
}

function SignInForm() {
  const params = useSearchParams()
  const next = params.get('next') ?? '/dashboard'
  const linkError = params.get('error')
  const verified = params.get('verified')

  const [state, action, pending] = useActionState<FormState, FormData>(
    signInWithCredentials,
    {},
  )

  const message = state.error ?? (linkError ? (ERRORS[linkError] ?? 'Something went wrong.') : null)

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="hint">Pick up where you left off.</p>

      {verified && (
        <p role="status" className="mt-6 rounded-xl border border-border bg-surface px-3 py-2 text-sm">
          Email verified. You can sign in now.
        </p>
      )}

      {message && (
        <p role="alert" className="mt-6 rounded-xl border border-danger/40 px-3 py-2 text-sm text-danger">
          {message}
        </p>
      )}

      <form action={signInWithGoogle} className="mt-6">
        <button type="submit" className="btn btn-secondary">
          Continue with Google
        </button>
      </form>

      <div className="my-6 flex items-center gap-3 text-sm text-muted">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <form action={action} className="space-y-4">
        <input type="hidden" name="next" value={next} />

        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            className="field"
          />
        </div>

        <div>
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="field"
          />
        </div>

        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="hint mt-6">
        No account?{' '}
        <Link href="/signup" className="text-accent underline underline-offset-2">
          Create one
        </Link>
      </p>
    </main>
  )
}

export default function SignInPage() {
  return (
    <Suspense>
      <SignInForm />
    </Suspense>
  )
}
