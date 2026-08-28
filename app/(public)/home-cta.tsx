'use client'

import Link from 'next/link'
import {useSession} from 'next-auth/react'

import {TRIAL_WORKSHEET_LIMIT} from '@/lib/ai/types'

export default function HomeCta() {
  const {data: session} = useSession()

  if (session && session.user) {
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
