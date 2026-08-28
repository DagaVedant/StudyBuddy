'use client'

import Link from 'next/link'
import {useEffect} from 'react'

export default function Error({
  error,
  reset,
}: {
  error: Error & {digest?: string}
  reset: () => void
}) {
  useEffect(() => {
    let digest = '(no digest)'
    if (error.digest) digest = error.digest

    console.error('[error boundary]', digest, error)
  }, [error])

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6">
      <h1 className="text-balance text-2xl font-semibold tracking-tight">
        Something went wrong
      </h1>
      <p className="hint text-pretty">
        Nothing you have saved is affected. This is usually worth one more try.
      </p>

      <p className="mt-6">
        <button
          type="button"
          onClick={reset}
          className="btn btn-primary touch-manipulation sm:w-auto sm:px-6"
        >
          Try again
        </button>
      </p>
      <p className="mt-3">
        <Link href="/dashboard" className="text-accent">
          Go to your dashboard
        </Link>
      </p>

      {error.digest && (
        <p className="mt-6 text-xs text-muted">
          Reference <span className="font-mono">{error.digest}</span>
        </p>
      )}
    </main>
  )
}
