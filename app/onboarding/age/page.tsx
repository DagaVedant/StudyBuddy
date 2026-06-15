'use client'

import { useRouter } from 'next/navigation'
import { useActionState, useEffect } from 'react'
import { useSession } from 'next-auth/react'

import { submitDob } from '@/lib/auth/actions'
import type { FormState } from '@/lib/auth/actions'
import { MIN_AGE_YEARS } from '@/lib/auth/policy'

export default function AgeGatePage() {
  const [state, action, pending] = useActionState<FormState, FormData>(submitDob, {})
  const { update } = useSession()
  const router = useRouter()

  // The proxy reads `hasDob` off the session token, so the token has to be
  // refreshed before navigating or we bounce straight back here.
  useEffect(() => {
    if (!state.message) return
    void update().then(() => router.replace('/dashboard'))
  }, [state.message, update, router])

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">One more thing</h1>
      <p className="hint">
        We need your date of birth. StudyBuddy is for people {MIN_AGE_YEARS} and older.
      </p>

      {state.error && (
        <p role="alert" className="mt-6 rounded border border-danger/40 px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}

      <form action={action} className="mt-6 space-y-4">
        <div>
          <label className="label" htmlFor="dob">
            Date of birth
          </label>
          <input id="dob" name="dob" type="date" required className="field" />
        </div>

        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? 'Saving…' : 'Continue'}
        </button>
      </form>
    </main>
  )
}
