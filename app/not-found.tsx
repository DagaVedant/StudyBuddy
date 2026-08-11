import Link from 'next/link'

export const metadata = { title: 'Not Found · StudyBuddy' }

/**
 * The 404, and the destination `proxy.ts` has been rewriting to all along.
 *
 * Seven pages call `notFound()` and the proxy rewrites a non-admin away from
 * `/admin` rather than answering 403, so the console cannot be found by
 * probing for it. Without this file all of that produced Next's own unstyled
 * error page: correct status, no branding, and no way back other than the
 * browser's back button.
 *
 * Deliberately says nothing about why. It answers a worksheet that does not
 * exist, a worksheet belonging to somebody else, and an admin page the reader
 * is not allowed to see, and those have to be indistinguishable or the last one
 * is a way of asking which pages exist.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-16 text-center">
      <p className="eyebrow">404</p>
      <h1 className="mt-2 text-balance text-2xl font-semibold tracking-tight">
        We could not find that
      </h1>
      <p className="hint text-pretty">
        The page may have moved, or it may belong to another account.
      </p>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
        <Link href="/dashboard" className="btn btn-primary sm:w-auto sm:px-6">
          Go to your dashboard
        </Link>
        <Link href="/worksheets" className="btn btn-secondary sm:w-auto sm:px-6">
          Your worksheets
        </Link>
      </div>
    </main>
  )
}
