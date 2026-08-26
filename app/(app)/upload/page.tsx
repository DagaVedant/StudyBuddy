import Link from 'next/link'
import {redirect} from 'next/navigation'
import {PageHead} from '@/components/page-head'

import {auth} from '@/auth'
import {resolveProvider} from '@/lib/ai/resolve'
import {db} from '@/lib/db'
import {queueDepth, workerStatus} from '@/lib/queue'
import {flattenTaxonomy} from '@/lib/taxonomy'
import {findSample} from '@/lib/upload'

import UploadClient, {type SubjectGroup} from './upload-client'

export const metadata = {title: 'Upload a Worksheet · StudyBuddy'}

interface Props {
  searchParams: Promise<{sample?: string}>
}

function subjectGroups(): SubjectGroup[] {
  const topics = flattenTaxonomy()
  const roots = topics.filter((topic) => topic.depth === 0)

  return roots.map((root) => {
    const children = topics.filter(
      (topic) => topic.depth === 1 && topic.parentSlug === root.slug,
    )

    return {
      label: root.name,
      options: [
        {slug: root.slug, label: `All of ${root.name}`},
        ...children.map((child) => ({slug: child.slug, label: child.name})),
      ],
    }
  })
}

export default async function UploadPage({searchParams}: Props) {
  const session = await auth()
  if (!session?.user?.id) redirect('/signin')

  const {sample} = await searchParams
  const resolved = await resolveProvider(db, session.user.id)

  const onOperatorGpu = resolved.executor === 'operator_gpu'
  const [worker, queue] = onOperatorGpu
    ? await Promise.all([workerStatus(db), queueDepth(db, 'operator_gpu')])
    : [null, null]

  const waiting = worker !== null && !worker.online
  const ahead = queue?.pending ?? 0
  const noReader = resolved.executor === 'none'

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10">
      <nav aria-label="Breadcrumb" className="mb-6 text-sm">
        <Link
          href="/dashboard"
          className="text-muted hover:text-fg"
        >
          Dashboard
        </Link>
      </nav>

      <div className="mb-8">
        <PageHead title="Upload a worksheet" />
      </div>

      {noReader && (
        <div className="mb-6 rounded-xl border border-caution/40 bg-caution/10 px-3 py-2 text-sm text-caution">
          <p role="status" className="text-pretty">
            Your free trial is used up, so anything you upload now will not be
            read for you: you can still add its questions by hand. To have them
            read again, connect your own AI provider in{' '}
            <Link href="/settings" className="underline">
              settings
            </Link>
            .
          </p>
        </div>
      )}

      {waiting && (
        <div className="mb-6 rounded-xl border border-caution/40 bg-caution/10 px-3 py-2 text-sm text-caution">
          <p role="status" className="text-pretty">
            The machine that reads papers is not running just now. Upload
            anyway and your paper waits in the queue, or type the questions in
            yourself.
          </p>
        </div>
      )}

      {!waiting && ahead > 0 && (
        <p role="status" className="hint mb-6 text-pretty">
          {ahead === 1 ? 'One paper is' : `${ahead} papers are`} ahead of yours in
          the queue.
        </p>
      )}

      <UploadClient
        subjects={subjectGroups()}
        initialSample={findSample(sample)?.slug}
      />
    </main>
  )
}
