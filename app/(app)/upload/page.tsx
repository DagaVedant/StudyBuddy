import Link from 'next/link'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import AiSetupPrompt from '@/components/ai-setup-prompt'
import { getAiStatus, shouldOfferAiSetup } from '@/lib/ai/resolve'
import { db } from '@/lib/db'
import { flattenTaxonomy } from '@/lib/taxonomy/trees'

import UploadClient, { type SubjectGroup } from './upload-client'

export const metadata = { title: 'Upload a Worksheet · StudyBuddy' }

function subjectGroups(): SubjectGroup[] {
  const topics = flattenTaxonomy()

  return topics
    .filter((topic) => topic.depth === 0)
    .map((root) => ({
      label: root.name,
      options: [
        { slug: root.slug, label: `All of ${root.name}` },
        ...topics
          .filter((topic) => topic.depth === 1 && topic.parentSlug === root.slug)
          .map((child) => ({ slug: child.slug, label: child.name })),
      ],
    }))
}

export default async function UploadPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/signin')

  // The second of spec.md:339's two screens, and the more useful of them: this
  // is the one a student is standing on when the choice actually costs them
  // something, with the file already picked.
  const aiStatus = await getAiStatus(db, session.user.id)

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10">
      <nav aria-label="Breadcrumb" className="mb-6 text-sm">
        <Link
          href="/dashboard"
          className="text-muted underline underline-offset-2 hover:text-fg"
        >
          Dashboard
        </Link>
      </nav>

      <h1 className="text-balance text-2xl font-semibold tracking-tight">
        Upload a worksheet
      </h1>
      <p className="hint mb-8 text-pretty">
        Upload one you have already finished. You will mark which questions you
        got wrong in the next step.
      </p>

      {/*
        Before the form, not after it. Which tier reads this worksheet is
        decided the moment it is submitted, so a prompt underneath the submit
        button would be advice arriving after the decision it is about.
      */}
      {shouldOfferAiSetup(aiStatus) && <AiSetupPrompt />}

      <UploadClient
        subjects={subjectGroups()}
        isAdmin={session.user.role === 'admin'}
      />
    </main>
  )
}
