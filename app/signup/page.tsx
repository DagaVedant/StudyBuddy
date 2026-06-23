'use client'

import Link from 'next/link'
import { useActionState } from 'react'

import { TRIAL_WORKSHEET_LIMIT } from '@/lib/ai/limits'
import { signUp } from '@/lib/auth/actions'
import type { FormState } from '@/lib/auth/actions'
import { MIN_AGE_YEARS } from '@/lib/auth/policy'

export default function SignUpPage() {
  const [state, action, pending] = useActionState<FormState, FormData>(signUp, {})

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Create an account</h1>
      <p className="hint">
        You start with {TRIAL_WORKSHEET_LIMIT} worksheets of free AI processing
        — no card, no setup.
      </p>

      {state.error && (
        <p role="alert" className="mt-6 rounded border border-danger/40 px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}

      {state.message && (
        <p role="status" className="mt-6 rounded border border-border bg-surface px-3 py-2 text-sm">
          {state.message}
        </p>
      )}

      <form action={action} className="mt-6 space-y-4">
        <div>
          <label className="label" htmlFor="name">
            Name <span className="font-normal text-muted">(optional)</span>
          </label>
          <input id="name" name="name" type="text" autoComplete="name" className="field" />
        </div>

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
            autoComplete="new-password"
            minLength={10}
            required
            className="field"
          />
          <p className="hint">At least 10 characters.</p>
        </div>

        <div>
          <label className="label" htmlFor="dob">
            Date of birth
          </label>
          <input id="dob" name="dob" type="date" required className="field" />
          <p className="hint">StudyBuddy is for people {MIN_AGE_YEARS} and older.</p>
        </div>

        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      <p className="hint mt-6">
        Already have an account?{' '}
        <Link href="/signin" className="text-accent underline underline-offset-2">
          Sign in
        </Link>
      </p>
    </main>
  )
}
