import Link from 'next/link'
import {redirect} from 'next/navigation'
import {PageHead} from '@/components/page-head'

import {auth} from '@/auth'
import {appBaseUrl} from '@/lib/api'
import {
  browserTierEnabled,
  cloudExtractionEnabled,
  getCredentialSummary,
  getTrialState,
} from '@/lib/ai/resolve'
import {db} from '@/lib/db'
import {workerStatus} from '@/lib/queue'

import SettingsClient, {DeleteAccount} from './settings-client'

export const metadata = {title: 'Settings · StudyBuddy'}

export default async function SettingsPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/signin')

  const userId = session.user.id

  const [credentials, trial, worker] = await Promise.all([
    getCredentialSummary(db, userId),
    getTrialState(db, userId),
    workerStatus(db),
  ])

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10">
      <div className="mb-8">
        <PageHead title="How StudyBuddy thinks" />
      </div>

      <SettingsClient
        showCloud={cloudExtractionEnabled()}
        showOllama={browserTierEnabled()}
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

      <section aria-labelledby="profile-heading" className="mt-8">
        <h2 id="profile-heading" className="mb-4 border-b border-fg/20 pb-2 text-sm font-medium">
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
