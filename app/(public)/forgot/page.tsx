'use client'

import Link from 'next/link'
import { useActionState } from 'react'

import { requestPasswordReset } from '@/lib/auth/actions'
import type { FormState } from '@/lib/auth/actions'

export default function ForgotPasswordPage() {
  const [state, action, pending] = useActionState<FormState, FormData>(
    requestPasswordReset,
    {},
  )

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Forgot your password</h1>
      <p className="hint text-pretty">
        Give us the address you signed up with and we will email you a link to set a
        new one. This also works if you have only ever signed in with Google and
        want a password as well.
      </p>

      {state.error && (
        <p
          role="alert"
          className="mt-6 rounded-xl border border-danger/40 px-3 py-2 text-sm text-danger"
        >
          {state.error}
        </p>
      )}

      {state.message ? (
        <p role="status" className="mt-6 text-pretty text-sm">
          {state.message}
        </p>
      ) : (
        <form action={action} className="mt-6 space-y-4">
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

          <button type="submit" className="btn btn-primary" disabled={pending}>
            {pending ? 'Sending…' : 'Email me a link'}
          </button>
        </form>
      )}

      <p className="hint mt-6">
        Remembered it?{' '}
        <Link href="/signin" className="text-accent underline underline-offset-2">
          Sign in
        </Link>
      </p>
    </main>
  )
}
