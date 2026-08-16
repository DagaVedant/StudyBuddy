import Link from 'next/link'
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

      {/*
        Profile lives here now rather than in a nav slot of its own. Two
        top-level slots for one account area was one too many, and the less
        important of them was listed first: this screen holds the provider
        setup, the trial and account deletion, and that one holds a display
        name, a username and an avatar. Somebody looking for either is already
        on this page.
      */}
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

      {/* Last on the page and in its own card, because it is the one control
          here that cannot be undone. */}
      {session.user.email && <DeleteAccount email={session.user.email} />}
    </main>
  )
}
