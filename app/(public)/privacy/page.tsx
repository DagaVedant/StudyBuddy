import Link from 'next/link'

import { POLICY_UPDATED, contactEmail } from '@/lib/rate-limit'

export const metadata = { title: 'Privacy · StudyBuddy' }

export default function PrivacyPage() {
  const contact = contactEmail()
  const noContact =
    'No contact address is set on this deployment. Whoever runs it should set CONTACT_EMAIL.'

  return (
    <main className="prose-page mx-auto w-full max-w-2xl px-6 py-12">
      <h1 className="text-balance text-2xl font-semibold tracking-tight">Privacy</h1>
      <p className="hint mb-8">Last updated {POLICY_UPDATED}.</p>

      <section className="space-y-3 text-pretty text-sm leading-6">
        <h2 className="text-base font-medium">What this is</h2>
        <p>
          StudyBuddy is a study tool run by one person, not a company. It takes
          worksheets a student has already done, pulls the questions out of them,
          and schedules what to revise. This page says what it stores, where that
          goes, and how to get rid of it.
        </p>

        <h2 className="pt-4 text-base font-medium">What it stores</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Your email address, and a name and username if you set them. If you
            sign in with a password, we store a bcrypt hash of it, never the
            password.
          </li>
          <li>
            Your date of birth. It is used once, to check you are 13 or older,
            and then kept so the check does not have to be repeated.
          </li>
          <li>
            The worksheets you upload: the page images, the text read off them,
            the questions, your answers, and the review schedule built from
            them.
          </li>
          <li>
            If you connect your own AI provider, the API key, encrypted with
            AES-256-GCM. It is decrypted only to make a request you asked for,
            and it is never shown back to you or sent to your browser.
          </li>
        </ul>

        <h2 className="pt-4 text-base font-medium">Where your worksheets go</h2>
        <p>
          This depends on which tier you are on, and the difference is the whole
          point of the tiers:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Free trial.</strong> Page images are read by a vision model
            on a machine the operator runs at home. They are held only while the
            job runs. They are not used to train anything.
          </li>
          <li>
            <strong>Your own API key.</strong> Page images and question text go
            to the provider you chose, under your own account and their terms.
            Nothing goes to the operator&rsquo;s machine.
          </li>
          <li>
            <strong>Your own Ollama.</strong> The model runs in your browser
            against your own computer. Question text does not leave your machine
            for any model at all.
          </li>
        </ul>
        <p>
          Page images are stored in Vercel Blob so the app can show you the page
          a question came from. The database is hosted by Neon. Both are in the
          United States.
        </p>

        <h2 className="pt-4 text-base font-medium">Who else is involved</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>Vercel, for hosting, and for page-view analytics that set no cookies.</li>
          <li>Neon, for the database.</li>
          <li>Google, if you choose to sign in with Google.</li>
          <li>
            An email provider, only to send a password reset link when you ask
            for one.
          </li>
          <li>
            Hugging Face, whose CDN serves the small sorting model your browser
            downloads once. It sees the request for the file, not your work.
          </li>
        </ul>
        <p>
          Nothing is sold, and nothing is shared with anyone for advertising.
          There are no advertising or tracking cookies. The only cookie is the
          one that keeps you signed in.
        </p>

        <h2 className="pt-4 text-base font-medium">Students under 13</h2>
        <p>
          Accounts require you to be 13 or older, and the check runs on the
          server rather than only in the date box. If you believe a younger child
          has an account, write to {contact ?? noContact} and it will be deleted.
        </p>

        <h2 className="pt-4 text-base font-medium">Deleting your data</h2>
        <p>
          Settings has a delete-account control. It asks you to type your own
          email address, and then removes the account and everything attached to
          it: worksheets, page images, questions, attempts, review schedule and
          any stored API key. It is immediate and cannot be undone. Backups of
          the database may hold a copy for a short period after that.
        </p>

        <h2 className="pt-4 text-base font-medium">Contact</h2>
        <p>
          Questions, corrections, or a request for a copy of your data: {contact ?? noContact}
        </p>
      </section>

      <p className="hint mt-10">
        <Link href="/terms" className="text-accent underline underline-offset-2">
          Terms of use
        </Link>
      </p>
    </main>
  )
}
