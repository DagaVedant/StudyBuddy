'use client'

import Link from 'next/link'
import { useSession } from 'next-auth/react'

import { TRIAL_WORKSHEET_LIMIT } from '@/lib/ai/limits'

/**
 * The one part of the pitch that depends on who is reading it.
 *
 * This was a server `auth()` call in the page, which reads cookies, which made
 * the pitch dynamic. That is the wrong trade for this page in particular:
 * almost everyone arriving here has no cookie to read, and they were paying for
 * a personalisation that did not apply to them by waiting on a render that
 * could have come from a CDN.
 *
 * So the page prerenders and this swaps after hydration. The signed-out pair is
 * what the HTML ships with, deliberately, because that is who the page is for
 * and a signed-in reader is one click from the dashboard either way.
 */
export default function HomeCta() {
  const { data: session, status } = useSession()

  if (status !== 'loading' && session?.user) {
    return (
      <div className="mt-8 flex w-full flex-col items-center sm:w-auto">
        <Link href="/dashboard" className="btn btn-primary sm:w-auto sm:px-8">
          Go to your dashboard
        </Link>
      </div>
    )
  }

  return (
    <>
      <div className="mt-8 flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row">
        <Link href="/signup" className="btn btn-primary sm:w-auto sm:px-8">
          Get started
        </Link>
        <Link href="/signin" className="btn btn-secondary sm:w-auto sm:px-8">
          Sign in
        </Link>
      </div>

      <p className="hint mt-4">
        Free to start: {TRIAL_WORKSHEET_LIMIT} full worksheets processed by AI,
        no card and no setup.
      </p>
    </>
  )
}
