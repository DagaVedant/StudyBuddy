'use client'

import Link from 'next/link'
import { useEffect } from 'react'

/**
 * What a student sees when a page throws.
 *
 * There was no boundary anywhere under `app/`, so an uncaught server error
 * rendered Next's default page: no branding, no retry, and no route out except
 * the back button. Every screen in this app is reached by a click from another
 * screen, so a dead end is a dead end for the session.
 *
 * `reset()` re-renders the segment rather than reloading. Most of what throws
 * here is a database read on a cold serverless function, and those succeed the
 * second time, so the useful button is the one that just tries again.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // The digest is the only handle on the server-side stack, which Next
    // deliberately does not send to the browser. Without it in the console
    // there is nothing to correlate a student's report against the logs.
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

      {/*
        Shown rather than hidden. A student reporting a problem has nothing else
        to quote, and this is the string that finds the request in the logs. It
        is an opaque hash: it carries no stack and nothing about the account.
      */}
      {error.digest && (
        <p className="mt-6 text-xs text-muted">
          Reference <span className="font-mono">{error.digest}</span>
        </p>
      )}
    </main>
  )
}
