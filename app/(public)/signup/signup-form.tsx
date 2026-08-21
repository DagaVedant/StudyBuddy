'use client'

import Link from 'next/link'
import { useActionState } from 'react'

import { GoogleButton } from '@/components/chrome'
import { TRIAL_WORKSHEET_LIMIT } from '@/lib/ai/types'
import { type FormState, signInWithGoogle, signUp } from '@/lib/auth/actions'
import { MIN_AGE_YEARS } from '@/lib/auth/policy'

export default function SignUpForm({ inviteRequired }: { inviteRequired: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(signUp, {})

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Create an account</h1>
      <p className="hint">
        You start with {TRIAL_WORKSHEET_LIMIT} worksheets of free AI processing,
        no card and no setup.
      </p>

      {state.error && (
        <p role="alert" className="mt-6 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}

      {state.message && (
        <p role="status" className="mt-6 rounded-xl bg-surface px-3 py-2 text-sm">
          {state.message}
        </p>
      )}

      <form action={signInWithGoogle} className="mt-6">
        <GoogleButton label="Sign up with Google" />
      </form>

      <div className="my-6 flex items-center gap-3 text-sm text-muted">
        <span className="h-px flex-1 bg-wash-strong" />
        or use a password
        <span className="h-px flex-1 bg-wash-strong" />
      </div>

      <form action={action} className="space-y-4">
        <div>
          <label className="label" htmlFor="name">
            Name
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

        {inviteRequired && (
          <div>
            <label className="label" htmlFor="invite">
              Invite code
            </label>
            <input
              id="invite"
              name="invite"
              type="text"
              autoComplete="off"
              spellCheck={false}
              required
              className="field"
            />
            <p className="hint">Sign-ups are invite-only just now.</p>
          </div>
        )}

        <button type="submit" className="btn btn-secondary" disabled={pending}>
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
