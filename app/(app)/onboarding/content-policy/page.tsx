'use client'

import Link from 'next/link'
import {useSession} from 'next-auth/react'
import {useId, useState, type FormEvent} from 'react'

import {acceptContentPolicy} from '@/lib/auth/actions'

export default function ContentPolicyGatePage() {
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
      const result = await acceptContentPolicy({}, formData)

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
      <h1 className="text-2xl font-semibold tracking-tight">Before you upload anything</h1>
      <p className="hint">
        Upload worksheets you are entitled to upload: your own work, papers
        your school gave you, past papers that are published for practice.
        Not a live exam, not material you have been told not to copy, and
        nothing with somebody else&rsquo;s personal information on it. See the{' '}
        <Link href="/terms" className="text-accent">
          terms
        </Link>{' '}
        for the rest.
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
            I own this content, or have the right to upload it, and I won&rsquo;t
            upload anything I&rsquo;ve been told not to copy.
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
