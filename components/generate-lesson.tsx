'use client'

import {useRouter} from 'next/navigation'
import {useState} from 'react'

import {OllamaProvider} from '@/lib/ai/ollama'
import {fetchJson} from '@/lib/client/http'
import {type LessonInput, validated} from '@/lib/ai/types'

interface LessonResponse {
  error?: string
  runsHere?: boolean
  input?: LessonInput
  ollama?: {baseUrl: string; textModel: string}
}

export function GenerateLessonButton({topicId}: {topicId: string}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function writeHere(input: LessonInput, ollama: {baseUrl: string; textModel: string}) {
    const provider = validated(
      new OllamaProvider({
        baseUrl: ollama.baseUrl,
        visionModel: ollama.textModel,
        textModel: ollama.textModel,
        executionSite: 'browser',
      }),
    )

    const lesson = await provider.teachTopic(input)

    const stored = await fetchJson(`/api/topics/${topicId}/lesson`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({lesson, model: ollama.textModel}),
    })

    if (!stored.ok) {
      const detail = (await stored.json().catch(() => ({}))) as {error?: string}
      throw new Error(detail.error ?? 'Could not save that lesson. Try again.')
    }
  }

  async function generate() {
    setBusy(true)
    setError(null)

    try {
      const response = await fetchJson(`/api/topics/${topicId}/lesson`, {method: 'POST'})
      const body = (await response.json().catch(() => ({}))) as LessonResponse

      if (!response.ok) {
        throw new Error(body.error ?? 'Could not generate that lesson. Try again.')
      }

      if (body.runsHere && body.input && body.ollama) {
        await writeHere(body.input, body.ollama)
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
        className="rounded-xl border border-rule bg-surface px-3 py-1.5 text-sm hover:border-accent hover:bg-accent/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
      >
        {busy ? 'Writing…' : 'Generate lesson overview'}
      </button>
      <p aria-live="polite" className="hint">
        {error ?? 'Written by a model, from questions in this topic. Takes a moment.'}
      </p>
    </div>
  )
}
