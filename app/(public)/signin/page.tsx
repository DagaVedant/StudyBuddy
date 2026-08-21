'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useActionState } from 'react'

import { GoogleButton } from '@/components/chrome'
import { signInWithCredentials, signInWithGoogle } from '@/lib/auth/actions'
import type { FormState } from '@/lib/auth/actions'
import { safeNextPath } from '@/lib/auth/policy'

const ERRORS: Record<string, string> = {
  OAuthAccountNotLinked: 'That email is already registered with a password. Sign in with your password instead.',
}

function SignInForm() {
  const params = useSearchParams()
  const next = safeNextPath(params.get('next'))
  const linkError = params.get('error')

  const [state, action, pending] = useActionState<FormState, FormData>(
    signInWithCredentials,
    {},
  )

  const message = state.error ?? (linkError ? (ERRORS[linkError] ?? 'Something went wrong.') : null)

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="hint">Pick up where you left off.</p>

      {message && (
        <p role="alert" className="mt-6 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
          {message}
        </p>
      )}

      <form action={signInWithGoogle} className="mt-6">
        <GoogleButton label="Sign in with Google" />
      </form>

      <div className="my-6 flex items-center gap-3 text-sm text-muted">
        <span className="h-px flex-1 bg-wash-strong" />
        or use a password
        <span className="h-px flex-1 bg-wash-strong" />
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

        <button type="submit" className="btn btn-secondary" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="hint mt-6">
        <Link href="/forgot" className="text-accent underline underline-offset-2">
          Forgot your password?
        </Link>
      </p>

      <p className="hint mt-2">
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
