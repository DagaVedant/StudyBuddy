'use client'

import { useSession } from 'next-auth/react'
import { useState, type FormEvent } from 'react'

import { submitDob } from '@/lib/auth/actions'
import { MIN_AGE_YEARS } from '@/lib/auth/policy'

export default function AgeGatePage() {
  const { update } = useSession()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return

    const formData = new FormData(event.currentTarget)

    setError(null)
    setPending(true)

    try {
      const result = await submitDob({}, formData)

      if (result.error) {
        setError(result.error)
        setPending(false)
        return
      }

      await update()

      window.location.assign('/dashboard')
    } catch {
      setError(
        'Your date of birth was saved, but your session did not refresh. Sign out and back in to continue.',
      )
      setPending(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">One more thing</h1>
      <p className="hint">
        We need your date of birth. StudyBuddy is for people {MIN_AGE_YEARS} and older.
      </p>

      {error && (
        <p
          role="alert"
          className="mt-6 rounded border border-danger/40 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div>
          <label className="label" htmlFor="dob">
            Date of birth
          </label>
          <input
            id="dob"
            name="dob"
            type="date"
            required
            autoFocus
            disabled={pending}
            className="field"
          />
        </div>

        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? 'Saving…' : 'Continue'}
        </button>
      </form>
    </main>
  )
}
