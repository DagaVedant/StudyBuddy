'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { fetchJson } from '@/lib/client/fetch-json'

/**
 * The student-facing way onto a topic's lesson.
 *
 * Lessons used to only exist if an operator had run
 * `scripts/generate-lessons.ts` by hand, so a topic nobody had pre-generated
 * for showed no lesson section at all, with nothing inviting a student to ask
 * for one. This is that invitation.
 *
 * It does not render the lesson itself. The topic page is a server
 * component that already reads the lesson from the database when it exists,
 * so on success this only has to make that read happen again.
 */
export default function GenerateLessonButton({ topicId }: { topicId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function generate() {
    setBusy(true)
    setError(null)

    try {
      const response = await fetchJson(`/api/topics/${topicId}/lesson`, {
        method: 'POST',
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string }

      if (!response.ok) {
        throw new Error(body.error ?? 'Could not generate that lesson. Try again.')
      }

      router.refresh()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={() => void generate()}
        className="rounded-xl border border-border px-3 py-1.5 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
      >
        {busy ? 'Writing…' : 'Generate lesson overview'}
      </button>
      <p aria-live="polite" className="hint">
        {error ?? 'Written by a model, from questions in this topic. Takes a moment.'}
      </p>
    </div>
  )
}
