import Link from 'next/link'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'

export default async function HomePage() {
  const session = await auth()
  if (session?.user) redirect('/dashboard')

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">StudyBuddy</h1>
      <p className="mt-3 text-muted">
        Upload the worksheets you have already done. StudyBuddy pulls out every
        question, tracks which ones you got wrong, and tells you what to study
        next — with a review schedule that actually sticks.
      </p>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Link href="/signup" className="btn btn-primary sm:w-auto sm:px-6">
          Get started
        </Link>
        <Link href="/signin" className="btn btn-secondary sm:w-auto sm:px-6">
          Sign in
        </Link>
      </div>

      <p className="hint mt-6">
        Free to start: 10 pages of AI processing, no card and no setup.
      </p>
    </main>
  )
}
