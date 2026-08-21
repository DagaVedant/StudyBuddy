import Link from 'next/link'

import { POLICY_UPDATED, contactEmail } from '@/lib/rate-limit'

export const metadata = { title: 'Terms · StudyBuddy' }

export default function TermsPage() {
  const contact = contactEmail()
  const noContact =
    'No contact address is set on this deployment. Whoever runs it should set CONTACT_EMAIL.'

  return (
    <main className="prose-page mx-auto w-full max-w-2xl px-6 py-12">
      <h1 className="text-balance text-2xl font-semibold tracking-tight">Terms of use</h1>
      <p className="hint mb-8">Last updated {POLICY_UPDATED}.</p>

      <section className="space-y-3 text-pretty text-sm leading-6">
        <h2 className="text-base font-medium">What you are agreeing to</h2>
        <p>
          StudyBuddy is run by one person as a study tool, not by a company, and
          it is offered as it is. Using it means accepting the terms on this
          page and the{' '}
          <Link href="/privacy" className="text-accent underline underline-offset-2">
            privacy page
          </Link>
          .
        </p>

        <h2 className="pt-4 text-base font-medium">Who may use it</h2>
        <p>
          You must be 13 or older. One account is for one student. Do not share
          your password.
        </p>

        <h2 className="pt-4 text-base font-medium">What you may upload</h2>
        <p>
          Upload worksheets you are entitled to upload: your own work, papers
          your school gave you, past papers that are published for practice.
          Do not upload material you have been told not to copy, a live exam,
          or anything containing somebody else&rsquo;s personal information. Do not
          upload anything you would mind an operator seeing while chasing a bug.
        </p>

        <h2 className="pt-4 text-base font-medium">What the model produces</h2>
        <p>
          Questions, answer keys, explanations, lessons and practice questions
          are produced by an AI model and are wrong sometimes. Every screen that
          shows generated work says where it came from. Check it against the
          paper before you rely on it, and do not treat an explanation here as a
          substitute for your teacher.
        </p>

        <h2 className="pt-4 text-base font-medium">Fair use of the free trial</h2>
        <p>
          The free trial is read on hardware the operator pays for, so it is
          capped: a few worksheets per account, and a daily ceiling across
          everybody. Do not automate uploads or open extra accounts to get past
          those caps. If you want more, connect your own AI provider in
          settings, which spends your own key rather than somebody else&rsquo;s
          electricity.
        </p>

        <h2 className="pt-4 text-base font-medium">Your data, and stopping</h2>
        <p>
          You can delete your account at any time in settings, which removes
          everything attached to it. The operator may suspend or delete an
          account that is being used to attack the service or to upload things
          this page forbids, and will say why by email where possible.
        </p>

        <h2 className="pt-4 text-base font-medium">No warranty</h2>
        <p>
          There is no guarantee that the service is available, that a worksheet
          will be read correctly, or that anything you upload will still be here
          tomorrow. Keep your own copies of anything that matters. To the extent
          the law allows, the operator is not liable for loss arising from use
          of the service.
        </p>

        <h2 className="pt-4 text-base font-medium">Changes</h2>
        <p>
          These terms may change. The date at the top says when they last did.
          Continuing to use the service after a change means accepting it.
        </p>

        <h2 className="pt-4 text-base font-medium">Contact</h2>
        <p>{contact ?? noContact}</p>
      </section>

      <p className="hint mt-10">
        <Link href="/privacy" className="text-accent underline underline-offset-2">
          Privacy
        </Link>
      </p>
    </main>
  )
}
