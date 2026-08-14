import { asc, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import AdminNav from '@/components/admin-nav'
import { db } from '@/lib/db'
import { topics } from '@/lib/db/schema'
import { createTopic, renameTopic, reparentTopic } from '@/lib/taxonomy/edit'

export const metadata = { title: 'Canonical Tree · StudyBuddy' }

async function findBySlug(slug: string) {
  const [row] = await db
    .select({ id: topics.id })
    .from(topics)
    .where(eq(topics.slug, slug.trim()))
    .limit(1)
  return row ?? null
}

export default async function AdminTreePage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/signin')
  if (session.user.role !== 'admin') notFound()

  const [allTopics, leaves] = await Promise.all([
    db
      .select({ slug: topics.slug, name: topics.name })
      .from(topics)
      .orderBy(asc(topics.slug)),
    db
      .select({ slug: topics.slug, name: topics.name })
      .from(topics)
      .where(eq(topics.isLeaf, true))
      .orderBy(asc(topics.slug)),
  ])

  async function add(formData: FormData) {
    'use server'

    const current = await auth()
    if (current?.user?.role !== 'admin') return

    const parent = await findBySlug(String(formData.get('parentSlug') ?? ''))
    const name = String(formData.get('name') ?? '')

    if (!parent) {
      console.warn(`[admin] add topic: no topic at that parent slug`)
    } else {
      const outcome = await createTopic(db, parent.id, name)
      if (!outcome.ok) console.warn(`[admin] add topic failed: ${outcome.reason}`)
    }

    revalidatePath('/admin/tree')
    revalidatePath('/dashboard')
  }

  async function rename(formData: FormData) {
    'use server'

    const current = await auth()
    if (current?.user?.role !== 'admin') return

    const target = await findBySlug(String(formData.get('targetSlug') ?? ''))
    const name = String(formData.get('name') ?? '')

    if (!target) {
      console.warn(`[admin] rename topic: no topic at that slug`)
    } else {
      const outcome = await renameTopic(db, target.id, name)
      if (!outcome.ok) console.warn(`[admin] rename topic failed: ${outcome.reason}`)
    }

    revalidatePath('/admin/tree')
    revalidatePath('/dashboard')
  }

  async function reparent(formData: FormData) {
    'use server'

    const current = await auth()
    if (current?.user?.role !== 'admin') return

    const target = await findBySlug(String(formData.get('targetSlug') ?? ''))
    const newParent = await findBySlug(String(formData.get('parentSlug') ?? ''))

    if (!target || !newParent) {
      console.warn(`[admin] reparent topic: slug did not resolve`)
    } else {
      const outcome = await reparentTopic(db, target.id, newParent.id)
      if (!outcome.ok) console.warn(`[admin] reparent topic failed: ${outcome.reason}`)
    }

    revalidatePath('/admin/tree')
    revalidatePath('/dashboard')
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="text-balance text-2xl font-semibold tracking-tight">Canonical tree</h1>
      <p className="hint mb-6">
        Signed in as {session.user.email}. <AdminNav current="/admin/tree" />
      </p>

      <div className="grid gap-6 sm:grid-cols-2">
        <section aria-labelledby="add-heading" className="card p-4">
          <h2 id="add-heading" className="text-sm font-medium">
            Add a topic
          </h2>
          <p className="hint mb-3 text-pretty">
            A new leaf under an existing topic, embedded from its name so it
            is classifiable immediately.
          </p>
          <form action={add} className="space-y-2">
            <input
              name="parentSlug"
              list="all-topics"
              placeholder="parent slug…"
              autoComplete="off"
              required
              className="w-full rounded-xl border border-border bg-transparent px-2 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            />
            <input
              name="name"
              placeholder="new topic name"
              required
              className="w-full rounded-xl border border-border bg-transparent px-2 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            />
            <button
              type="submit"
              className="min-h-11 w-full rounded-xl border border-border px-2 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Add
            </button>
          </form>
        </section>

        <section aria-labelledby="rename-heading" className="card p-4">
          <h2 id="rename-heading" className="text-sm font-medium">
            Rename a topic
          </h2>
          <p className="hint mb-3 text-pretty">
            Changes only the display name. The slug, and every question
            already tagged by it, are untouched.
          </p>
          <form action={rename} className="space-y-2">
            <input
              name="targetSlug"
              list="all-topics"
              placeholder="topic slug…"
              autoComplete="off"
              required
              className="w-full rounded-xl border border-border bg-transparent px-2 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            />
            <input
              name="name"
              placeholder="new name"
              required
              className="w-full rounded-xl border border-border bg-transparent px-2 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            />
            <button
              type="submit"
              className="min-h-11 w-full rounded-xl border border-border px-2 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Rename
            </button>
          </form>
        </section>

        <section aria-labelledby="reparent-heading" className="card p-4 sm:col-span-2">
          <h2 id="reparent-heading" className="text-sm font-medium">
            Move a leaf
          </h2>
          <p className="hint mb-3 text-pretty">
            Leaves only: an internal topic&apos;s slug is the path every one of
            its descendants&apos; slugs is built from, so moving one would mean
            rewriting all of them. A misfiled leaf has no descendants to drag
            along.
          </p>
          <form action={reparent} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <input
              name="targetSlug"
              list="leaf-topics"
              placeholder="leaf to move…"
              autoComplete="off"
              required
              className="min-w-0 rounded-xl border border-border bg-transparent px-2 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            />
            <input
              name="parentSlug"
              list="all-topics"
              placeholder="new parent slug…"
              autoComplete="off"
              required
              className="min-w-0 rounded-xl border border-border bg-transparent px-2 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            />
            <button
              type="submit"
              className="min-h-11 rounded-xl border border-border px-3 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Move
            </button>
          </form>
        </section>
      </div>

      <datalist id="all-topics">
        {allTopics.map((topic) => (
          <option key={topic.slug} value={topic.slug}>
            {topic.name}
          </option>
        ))}
      </datalist>
      <datalist id="leaf-topics">
        {leaves.map((topic) => (
          <option key={topic.slug} value={topic.slug}>
            {topic.name}
          </option>
        ))}
      </datalist>
    </main>
  )
}
