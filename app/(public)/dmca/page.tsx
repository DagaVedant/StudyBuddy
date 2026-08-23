import Link from 'next/link'

import {POLICY_UPDATED, contactEmail} from '@/lib/api'

export const metadata = {title: 'Copyright (DMCA) · StudyBuddy'}

export default function DmcaPage() {
  const contact = contactEmail()
  const noContact =
    'No contact address is set on this deployment. Whoever runs it should set CONTACT_EMAIL.'

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-12">
      <h1 className="text-balance text-2xl font-semibold tracking-tight">
        Copyright complaints
      </h1>
      <p className="hint mb-8">Last updated {POLICY_UPDATED}.</p>

      <section className="space-y-3 text-pretty text-sm leading-6">
        <p>
          StudyBuddy only wants worksheets people are entitled to upload, as
          the{' '}
          <Link href="/terms" className="text-accent">
            terms
          </Link>{' '}
          already say. If something on here is yours and you did not authorize
          it, you can ask for it to come down under the Digital Millennium
          Copyright Act.
        </p>

        <h2 className="pt-4 text-base font-medium">How to send a takedown notice</h2>
        <p>Email the address below with all of the following, or the notice cannot be acted on:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Your physical or electronic signature.</li>
          <li>What the copyrighted work is, and enough detail to identify it.</li>
          <li>
            Which worksheet or page on StudyBuddy has it, specific enough to
            find (a link, if you have one, or a title and approximate date).
          </li>
          <li>Your address, phone number, and email address.</li>
          <li>
            A statement that you believe in good faith that the use is not
            authorized by the copyright owner, its agent, or the law.
          </li>
          <li>
            A statement, made under penalty of perjury, that the notice is
            accurate and that you are the copyright owner or authorized to act
            for them.
          </li>
        </ul>

        <h2 className="pt-4 text-base font-medium">What happens next</h2>
        <p>
          A notice with all of the above gets the material taken down or
          disabled. The account that uploaded it is told what was removed and
          why, and given the operator&rsquo;s reason to believe the notice is
          valid. An account with repeated valid notices against it is
          suspended or deleted, as the{' '}
          <Link href="/terms" className="text-accent">
            terms
          </Link>{' '}
          already allow.
        </p>

        <h2 className="pt-4 text-base font-medium">If you think a takedown was wrong</h2>
        <p>
          The student who uploaded it can send a counter-notice: their
          signature, identification of what was removed and where it was
          before removal, a statement under penalty of perjury that they have
          a good-faith belief the material was removed by mistake or
          misidentification, their name, address and phone number, and a
          statement consenting to the jurisdiction of their local federal
          district court. Send it to the same address, and the material may
          go back up unless the original complainant files a court action
          first.
        </p>

        <h2 className="pt-4 text-base font-medium">Where to send it</h2>
        <p>{contact ?? noContact}</p>
      </section>

      <p className="hint mt-10 flex gap-4">
        <Link href="/terms" className="text-accent">
          Terms of use
        </Link>
        <Link href="/privacy" className="text-accent">
          Privacy
        </Link>
      </p>
    </main>
  )
}
