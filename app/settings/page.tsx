import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { getTrialState } from '@/lib/ai/quota'
import { getCredentialSummary } from '@/lib/ai/resolve'
import type { Db } from '@/lib/dashboard/queries'
import { db } from '@/lib/db'
import { workerStatus } from '@/lib/queue'

import SettingsClient from './settings-client'

export const metadata = { title: 'Settings · StudyBuddy' }

export default async function SettingsPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/signin')

  const client = db as unknown as Db

  const [credentials, trial, worker] = await Promise.all([
    getCredentialSummary(client, session.user.id),
    getTrialState(client, session.user.id),
    workerStatus(client),
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
          pagesRemaining: trial.pagesRemaining,
          explanationsRemaining: trial.explanationsRemaining,
        }}
        workerOnline={worker.online}
        appUrl={process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}
      />
    </main>
  )
}
