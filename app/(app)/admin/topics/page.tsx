import { asc, desc, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import AdminNav from '@/components/admin-nav'
import { acceptTopicProposal, mergeTopicProposal } from '@/lib/classify/proposals'
import { db } from '@/lib/db'
import { questions, topicProposals, topics } from '@/lib/db/schema'
import { queueDepth, workerStatus } from '@/lib/queue'

export const metadata = { title: 'Topic Proposals · StudyBuddy' }

export default async function AdminTopicsPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/signin')
  if (session.user.role !== 'admin') notFound()


  const proposals = await db
    .select({
      id: topicProposals.id,
      proposedName: topicProposals.proposedName,
      status: topicProposals.status,
      createdAt: topicProposals.createdAt,
      sourcePrompt: questions.promptText,
      parentName: topics.name,
    })
    .from(topicProposals)
    .leftJoin(questions, eq(questions.id, topicProposals.sourceQuestionId))
    .leftJoin(topics, eq(topics.id, topicProposals.suggestedParentId))
    .where(eq(topicProposals.status, 'pending'))
    .orderBy(desc(topicProposals.createdAt))
    .limit(100)

  const [worker, gpuDepth, serverDepth, leaves] = await Promise.all([
    workerStatus(db),
    queueDepth(db, 'operator_gpu'),
    queueDepth(db, 'server'),
    // For the merge picker below: an existing leaf is the only thing a
    // proposal can ever merge into, matching what `mergeTopicProposal`
    // itself refuses anything else for.
    db
      .select({ slug: topics.slug, name: topics.name })
      .from(topics)
      .where(eq(topics.isLeaf, true))
      .orderBy(asc(topics.slug)),
  ])

  async function resolve(formData: FormData) {
    'use server'

    const current = await auth()
    if (current?.user?.role !== 'admin') return

    const id = String(formData.get('id'))
    const action = String(formData.get('action'))

    if (action === 'accept') {
      const outcome = await acceptTopicProposal(db, id)
      if (!outcome.ok) {
        console.warn(`[admin] could not accept proposal ${id}: ${outcome.reason}`)
      }
    } else if (action === 'merge') {
      const slug = String(formData.get('targetSlug') ?? '').trim()
      const [target] = await db
        .select({ id: topics.id })
        .from(topics)
        .where(eq(topics.slug, slug))
        .limit(1)

      if (!target) {
        console.warn(`[admin] could not merge proposal ${id}: no leaf at slug "${slug}"`)
      } else {
        const outcome = await mergeTopicProposal(db, id, target.id)
        if (!outcome.ok) {
          console.warn(`[admin] could not merge proposal ${id}: ${outcome.reason}`)
        }
      }
    } else {
      await db
        .update(topicProposals)
        .set({ status: 'rejected' })
        .where(eq(topicProposals.id, id))
    }

    revalidatePath('/admin/topics')
    revalidatePath('/dashboard')
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="text-balance text-2xl font-semibold tracking-tight">Admin</h1>
      <p className="hint mb-6">
        Signed in as {session.user.email}. <AdminNav current="/admin/topics" />
      </p>

      <section
        aria-labelledby="workers-heading"
        className="card p-4"
      >
        <h2 id="workers-heading" className="text-sm font-medium">
          Workers &amp; queue
        </h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-muted">GPU worker</dt>
            <dd className="mt-0.5 font-medium">
              {/* The count only where it says something a name does not: this
                  is the fleet view, and one of two workers being up reads very
                  differently from the only one being up. */}
              {worker.online
                ? worker.onlineCount > 1
                  ? `online (${worker.onlineCount} workers)`
                  : `online (${worker.name})`
                : 'offline'}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Model</dt>
            <dd className="mt-0.5 font-medium">{worker.modelName ?? 'none'}</dd>
          </div>
          <div>
            <dt className="text-muted">GPU queue</dt>
            <dd className="mt-0.5 font-medium tabular-nums">
              {gpuDepth.pending} pending · {gpuDepth.running} running
            </dd>
          </div>
          <div>
            <dt className="text-muted">Server queue</dt>
            <dd className="mt-0.5 font-medium tabular-nums">
              {serverDepth.pending} pending · {serverDepth.running} running
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="proposals-heading" className="mt-6">
        <h2 id="proposals-heading" className="text-sm font-medium">
          Topic proposals ({proposals.length})
        </h2>
        <p className="hint mb-3 text-pretty">
          Raised when the classifier could not fit a question to any canonical
          leaf. Accept adds it to the tree under its suggested parent; merge
          tags the source question against an existing leaf instead, for a
          proposal that turns out to already have a home the shortlist missed.
        </p>

        {proposals.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border px-3 py-8 text-center text-sm text-muted">
            Nothing pending.
          </p>
        ) : (
          <ul className="card divide-y divide-border overflow-hidden">
            {proposals.map((proposal) => (
              <li key={proposal.id} className="p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{proposal.proposedName}</p>
                    {proposal.parentName && (
                      <p className="text-xs text-muted">
                        suggested under {proposal.parentName}
                      </p>
                    )}
                    {proposal.sourcePrompt && (
                      <p className="mt-1 line-clamp-2 text-sm text-muted">
                        {proposal.sourcePrompt}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 gap-2">
                    <form action={resolve}>
                      <input type="hidden" name="id" value={proposal.id} />
                      <input type="hidden" name="action" value="accept" />
                      <button
                        type="submit"
                        className="rounded-xl border border-border px-2 py-1 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        Accept
                      </button>
                    </form>
                    <form action={resolve}>
                      <input type="hidden" name="id" value={proposal.id} />
                      <input type="hidden" name="action" value="reject" />
                      <button
                        type="submit"
                        className="rounded-xl border border-border px-2 py-1 text-sm text-muted hover:border-danger hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        Reject
                      </button>
                    </form>
                  </div>
                </div>

                <form action={resolve} className="mt-2 flex items-center gap-2">
                  <input type="hidden" name="id" value={proposal.id} />
                  <input type="hidden" name="action" value="merge" />
                  <label className="sr-only" htmlFor={`merge-${proposal.id}`}>
                    Existing topic slug to merge into
                  </label>
                  <input
                    id={`merge-${proposal.id}`}
                    name="targetSlug"
                    list="leaf-topics"
                    placeholder="merge into existing leaf…"
                    autoComplete="off"
                    className="min-w-0 flex-1 rounded-xl border border-border bg-transparent px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  />
                  <button
                    type="submit"
                    className="btn-compact shrink-0 rounded-xl border border-border px-2 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    Merge
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}

        <datalist id="leaf-topics">
          {leaves.map((leaf) => (
            <option key={leaf.slug} value={leaf.slug}>
              {leaf.name}
            </option>
          ))}
        </datalist>
      </section>
    </main>
  )
}
