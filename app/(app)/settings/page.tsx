import Link from 'next/link'
import { redirect } from 'next/navigation'
import { PageHead } from '@/components/ui'

import { auth } from '@/auth'
import { getTrialState } from '@/lib/ai/resolve'
import { appBaseUrl } from '@/lib/request'
import { getCredentialSummary } from '@/lib/ai/resolve'
import { db } from '@/lib/db'
import { workerStatus } from '@/lib/queue'

import SettingsClient, { DeleteAccount } from './settings-client'

export const metadata = { title: 'Settings · StudyBuddy' }

export default async function SettingsPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/signin')

  const [credentials, trial, worker] = await Promise.all([
    getCredentialSummary(db, session.user.id),
    getTrialState(db, session.user.id),
    workerStatus(db),
  ])

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10">
      <div className="mb-8">
        <PageHead
          title="How StudyBuddy thinks"
          lede="Review, spaced repetition, and your dashboard work on every option below. This only changes how questions get pulled off the page and whether you get explanations."
        />
      </div>

      <SettingsClient
        credentials={credentials.map((row) => ({
          provider: row.provider,
          keyLast4: row.keyLast4,
          ollamaBaseUrl: row.ollamaBaseUrl,
          visionModelName: row.visionModelName,
        }))}
        trial={{
          worksheetsRemaining: trial.worksheetsRemaining,
          explanationsRemaining: trial.explanationsRemaining,
        }}
        workerOnline={worker.online}
        appUrl={appBaseUrl()}
      />

      <section aria-labelledby="profile-heading" className="card mt-6 p-4">
        <h2 id="profile-heading" className="text-sm font-medium">
          Your profile
        </h2>
        <p className="hint text-pretty">
          Your display name, username and picture, with how much you have got
          through so far.
        </p>
        <Link href="/profile" className="btn btn-secondary mt-3 sm:w-auto sm:px-6">
          Open your profile
        </Link>
      </section>

      {session.user.email && <DeleteAccount email={session.user.email} />}
    </main>
  )
}
