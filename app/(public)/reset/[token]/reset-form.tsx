'use client'

import Link from 'next/link'
import { useActionState } from 'react'

import { type FormState, resetPassword } from '@/lib/auth/actions'

export default function ResetForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(resetPassword, {})

  if (state.message) {
    return (
      <>
        <p role="status" className="mt-6 text-pretty text-sm">
          {state.message}
        </p>
        <Link href="/signin" className="btn btn-primary mt-6">
          Sign in
        </Link>
      </>
    )
  }

  return (
    <>
      {state.error && (
        <p
          role="alert"
          className="mt-6 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {state.error}
        </p>
      )}

      <form action={action} className="mt-6 space-y-4">
        <input type="hidden" name="token" value={token} />

        <div>
          <label className="label" htmlFor="password">
            New password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
            className="field"
          />
          <p className="hint">At least 10 characters.</p>
        </div>

        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? 'Saving…' : 'Set my password'}
        </button>
      </form>
    </>
  )
}
