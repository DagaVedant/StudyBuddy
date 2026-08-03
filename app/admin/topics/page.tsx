import { desc, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { questions, topicProposals, topics } from '@/lib/db/schema'
import { queueDepth, workerStatus } from '@/lib/queue'
import type { Db } from '@/lib/dashboard/queries'

export const metadata = { title: 'Topic Proposals · StudyBuddy' }

export default async function AdminTopicsPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/signin')
  if (session.user.role !== 'admin') notFound()

  const client = db as unknown as Db

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

  const [worker, gpuDepth, serverDepth] = await Promise.all([
    workerStatus(client),
    queueDepth(client, 'operator_gpu'),
    queueDepth(client, 'server'),
  ])

  async function resolve(formData: FormData) {
    'use server'

    const current = await auth()
    if (current?.user?.role !== 'admin') return

    const id = String(formData.get('id'))
    const action = String(formData.get('action'))

    await db
      .update(topicProposals)
      .set({ status: action === 'accept' ? 'accepted' : 'rejected' })
      .where(eq(topicProposals.id, id))

    revalidatePath('/admin/topics')
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="text-balance text-2xl font-semibold tracking-tight">Admin</h1>
      <p className="hint mb-6">Signed in as {session.user.email}.</p>

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
              {worker.online ? `online (${worker.name})` : 'offline'}
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
          leaf. Accepting one does not create the topic yet. It marks it for the
          next taxonomy update.
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
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
