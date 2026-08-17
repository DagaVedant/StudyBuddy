'use client'

import Link from 'next/link'
import { useEffect } from 'react'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[error boundary]', error.digest ?? '(no digest)', error)
  }, [error])

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-16 text-center">
      <h1 className="text-balance text-2xl font-semibold tracking-tight">
        Something went wrong
      </h1>
      <p className="hint text-pretty">
        Nothing you have saved is affected. This is usually worth one more try.
      </p>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
        <button
          type="button"
          onClick={reset}
          className="btn btn-primary touch-manipulation sm:w-auto sm:px-6"
        >
          Try again
        </button>
        <Link href="/dashboard" className="btn btn-secondary sm:w-auto sm:px-6">
          Go to your dashboard
        </Link>
      </div>

      {error.digest && (
        <p className="mt-6 text-xs text-muted">
          Reference <span className="font-mono">{error.digest}</span>
        </p>
      )}
    </main>
  )
}
