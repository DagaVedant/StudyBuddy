import Link from 'next/link'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
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
  if (!session?.user) redirect('/signin')

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
        Upload a Worksheet
      </h1>
      <p className="hint mb-8 text-pretty">
        Upload one you have already finished. You will mark which questions you
        got wrong in the next step.
      </p>

      <UploadClient
        subjects={subjectGroups()}
        isAdmin={session.user.role === 'admin'}
      />
    </main>
  )
}
