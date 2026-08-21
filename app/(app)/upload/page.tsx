import Link from 'next/link'
import { redirect } from 'next/navigation'
import { PageHead } from '@/components/ui'

import { auth } from '@/auth'
import { AiSetupPrompt } from '@/components/ui'
import { getAiStatus, resolveProvider, shouldOfferAiSetup } from '@/lib/ai/resolve'
import { db } from '@/lib/db'
import { queueDepth, workerStatus } from '@/lib/queue'
import { flattenTaxonomy } from '@/lib/taxonomy'

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

  const [aiStatus, resolved] = await Promise.all([
    getAiStatus(db, session.user.id),
    resolveProvider(db, session.user.id),
  ])

  const onOperatorGpu = resolved.executor === 'operator_gpu'
  const [worker, queue] = onOperatorGpu
    ? await Promise.all([workerStatus(db), queueDepth(db, 'operator_gpu')])
    : [null, null]

  const waiting = worker !== null && !worker.online
  const ahead = queue?.pending ?? 0

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

      <div className="mb-8">
        <PageHead
          title="Upload a worksheet"
          lede="Upload one you have already finished. You will mark which questions you got wrong in the next step."
        />
      </div>

      {waiting && (
        <div className="mb-6 rounded-xl border border-caution/40 bg-caution/10 px-3 py-2 text-sm text-caution">
          <p role="status" className="text-pretty">
            The machine that reads papers on the free trial is not running just
            now. Upload anyway if you like: your paper waits in the queue and is
            read as soon as it is back, and the bell tells you when it is done.
            There is no way to say how long that will be.
          </p>
          <p className="mt-2 text-pretty">
            To not wait, connect your own AI in{' '}
            <Link href="/settings" className="underline underline-offset-2">
              settings
            </Link>
            , or upload and type the questions in yourself.
          </p>
        </div>
      )}

      {!waiting && ahead > 0 && (
        <p role="status" className="hint mb-6 text-pretty">
          {ahead === 1 ? 'One paper is' : `${ahead} papers are`} ahead of yours in
          the queue.
        </p>
      )}

      {shouldOfferAiSetup(aiStatus) && <AiSetupPrompt />}

      <UploadClient
        subjects={subjectGroups()}
      />
    </main>
  )
}
