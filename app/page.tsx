import Link from 'next/link'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { TRIAL_WORKSHEET_LIMIT } from '@/lib/ai/limits'

export default async function HomePage() {
  const session = await auth()
  if (session?.user) redirect('/dashboard')

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-16 sm:py-24">
      <p className="eyebrow">Practice, measured</p>

      <h1 className="display mt-4 text-[clamp(2.75rem,11vw,7.5rem)]">
        Know what
        <br />
        you don&rsquo;t know
      </h1>

      <p className="mt-8 max-w-xl text-lg text-pretty text-muted">
        Upload the worksheets you have already done. StudyBuddy pulls out every
        question, tracks which ones you got wrong, and tells you what to study
        next, with a review schedule that actually sticks.
      </p>

      <div className="mt-10 flex flex-col gap-3 sm:flex-row">
        <Link href="/signup" className="btn btn-primary sm:w-auto sm:px-8">
          Get started
        </Link>
        <Link href="/signin" className="btn btn-secondary sm:w-auto sm:px-8">
          Sign in
        </Link>
      </div>

      <p className="hint mt-6">
        Free to start: {TRIAL_WORKSHEET_LIMIT} full worksheets processed by AI,
        no card and no setup.
      </p>

      <dl className="mt-20 grid gap-4 sm:grid-cols-3">
        {[
          {
            term: 'Every question',
            detail:
              'Not just the ones you got wrong. A weak topic means nothing without knowing how many you saw.',
            tint: 'bg-tint-mint',
          },
          {
            term: 'Sorted by topic',
            detail:
              'Questions land in a subject tree, so the dashboard points at a skill rather than a worksheet.',
            tint: 'bg-tint-peach',
          },
          {
            term: 'Scheduled to stick',
            detail:
              'Spaced repetition brings a question back exactly when you are about to forget it.',
            tint: 'bg-tint-lavender',
          },
        ].map((item) => (
          <div key={item.term} className={`rounded-2xl p-6 ${item.tint}`}>
            <dt className="font-semibold tracking-tight">{item.term}</dt>
            <dd className="mt-2 text-sm text-pretty text-muted">{item.detail}</dd>
          </div>
        ))}
      </dl>
    </main>
  )
}
