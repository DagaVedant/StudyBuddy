'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { fetchJson } from '@/lib/client/fetch-json'

export default function GeneratePracticeButton({ topicId }: { topicId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function generate() {
    setBusy(true)
    setMessage(null)

    try {
      const response = await fetchJson(`/api/topics/${topicId}/practice`, {
        method: 'POST',
      })
      const body = (await response.json().catch(() => ({}))) as {
        error?: string
        created?: number
      }

      if (!response.ok) {
        throw new Error(body.error ?? 'Could not write practice questions. Try again.')
      }

      const created = body.created ?? 0
      setMessage(
        `${created} new ${created === 1 ? 'question' : 'questions'} added to your review queue.`,
      )
      router.refresh()
    } catch (cause) {
      setMessage((cause as Error).message)
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
        {busy ? 'Writing…' : 'Write me practice questions'}
      </button>
      <p aria-live="polite" className="hint">
        {message ??
          'Four new questions on this topic, written by a model and dropped into your review queue.'}
      </p>
    </div>
  )
}
