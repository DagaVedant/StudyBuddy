'use client'

import Link from 'next/link'
import {useSession} from 'next-auth/react'
import {useId, useState, type FormEvent} from 'react'

import {acceptTerms} from '@/lib/auth/actions'

export default function TermsGatePage() {
  const {update} = useSession()
  const agreeId = useId()
  const [checked, setChecked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const formData = new FormData(event.currentTarget)

    setError(null)
    setPending(true)

    try {
      const result = await acceptTerms({}, formData)

      if (result.error) {
        setError(result.error)
        setPending(false)
        return
      }

      await update()

      window.location.assign('/dashboard')
    } catch {
      setError(
        'That was saved, but your session did not refresh. Sign out and back in to continue.',
      )
      setPending(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Before you continue</h1>
      <p className="hint">
        StudyBuddy runs on a few rules, including only uploading worksheets
        you own or have the right to use. Read the{' '}
        <Link href="/terms" className="text-accent">
          terms
        </Link>{' '}
        and the{' '}
        <Link href="/privacy" className="text-accent">
          privacy page
        </Link>{' '}
        before you agree to them.
      </p>

      {error && (
        <p
          role="alert"
          className="mt-6 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div className="flex items-start gap-2.5">
          <input
            id={agreeId}
            name="agree"
            type="checkbox"
            required
            disabled={pending}
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
            className="mt-0.5 size-4 shrink-0"
          />
          <label htmlFor={agreeId} className="text-sm">
            I agree to the Terms of Service and Privacy Policy, including
            that I will only upload worksheets I own or have the right to
            use.
          </label>
        </div>

        <button
          type="submit"
          className="btn btn-primary"
          disabled={pending || !checked}
        >
          {pending ? 'Saving…' : 'Continue'}
        </button>
      </form>
    </main>
  )
}
