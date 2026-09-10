import Link from 'next/link'
import {redirect} from 'next/navigation'
import {PageHead} from '@/components/page-head'

import {auth} from '@/auth'
import {resolveProvider} from '@/lib/ai/resolve'
import {db} from '@/lib/db'
import {flattenTaxonomy} from '@/lib/taxonomy'
import {findSample} from '@/lib/upload'

import UploadClient, {type SubjectGroup} from './upload-client'

export const metadata = {title: 'Upload a Worksheet · StudyBuddy'}

type Props = {
  searchParams: Promise<{sample?: string}>
}

function subjectGroups(): SubjectGroup[] {
  const topics = flattenTaxonomy()
  const groups: SubjectGroup[] = []

  for (const root of topics) {
    if (root.depth !== 0) continue

    const options = [{slug: root.slug, label: 'All of ' + root.name}]

    for (const child of topics) {
      if (child.depth !== 1) continue
      if (child.parentSlug !== root.slug) continue

      options.push({slug: child.slug, label: child.name})
    }

    groups.push({label: root.name, options})
  }

  return groups
}

export default async function UploadPage({searchParams}: Props) {
  const session = await auth()
  if (!session || !session.user || !session.user.id) redirect('/signin')

  const {sample} = await searchParams
  const resolved = await resolveProvider(db, session.user.id)

  const noReader = resolved.executor === 'none'

  let noReaderLine =
    'Your free trial is used up, so anything you upload now will not be read for you: ' +
    'you can still add its questions by hand. To have them read again, connect your ' +
    'own AI provider in'
  if (resolved.tier === 'trial') {
    noReaderLine =
      'Nothing is set up to read worksheets on this deployment right now, so anything ' +
      'you upload will not be read for you: you can still add its questions by hand. ' +
      'To have them read, connect your own AI provider in'
  }

  const startingSample = findSample(sample)

  let initialSample = undefined
  if (startingSample) initialSample = startingSample.slug

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
            {noReaderLine}{' '}
            <Link href="/settings" className="underline">
              settings
            </Link>
            .
          </p>
        </div>
      )}

      <UploadClient subjects={subjectGroups()} initialSample={initialSample} />
    </main>
  )
}
