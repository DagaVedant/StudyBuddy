'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { fetchJson } from '@/lib/client/fetch-json'

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
