import Link from 'next/link'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import DashboardPreview from '@/components/dashboard-preview'
import Hero from '@/components/hero'
import { TRIAL_WORKSHEET_LIMIT } from '@/lib/ai/limits'

export default async function HomePage() {
  const session = await auth()
  if (session?.user) redirect('/dashboard')

  return (
    <main>
      <Hero>
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
      </Hero>

      <DashboardPreview />
    </main>
  )
}
