import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { getTrialState } from '@/lib/ai/quota'
import { appBaseUrl } from '@/lib/app-url'
import { getCredentialSummary } from '@/lib/ai/resolve'
import { db } from '@/lib/db'
import { workerStatus } from '@/lib/queue'

import DeleteAccount from './delete-account'
import SettingsClient from './settings-client'

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
      <h1 className="text-balance text-2xl font-semibold tracking-tight">
        How StudyBuddy Thinks
      </h1>
      <p className="hint mb-8 text-pretty">
        Review, spaced repetition, and your dashboard work on every option
        below. This only changes how questions get pulled off the page and
        whether you get explanations.
      </p>

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

      {/* Last on the page and in its own card, because it is the one control
          here that cannot be undone. */}
      {session.user.email && <DeleteAccount email={session.user.email} />}
    </main>
  )
}
