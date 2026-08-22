'use client'

import {useRouter} from 'next/navigation'
import {useState} from 'react'

import {OllamaProvider} from '@/lib/ai/ollama'
import {explainOllamaFailure, fetchJson} from '@/lib/client/http'
import {type PracticeInput, validated} from '@/lib/ai/types'

interface PracticeResponse {
  error?: string
  created?: number
  runsHere?: boolean
  input?: PracticeInput
  ollama?: {baseUrl: string; textModel: string}
}

export function GeneratePracticeButton({topicId}: {topicId: string}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function writeHere(
    input: PracticeInput,
    ollama: {baseUrl: string; textModel: string},
  ): Promise<number> {
    setMessage('Your machine is writing them. Keep this tab open.')

    const provider = validated(
      new OllamaProvider({
        baseUrl: ollama.baseUrl,
        visionModel: ollama.textModel,
        textModel: ollama.textModel,
        executionSite: 'browser',
      }),
    )

    const questions = await provider
      .writePractice(input)
      .catch((cause: unknown) => {
        throw new Error(explainOllamaFailure(cause, ollama.baseUrl))
      })

    const stored = await fetchJson(`/api/topics/${topicId}/practice`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({questions, count: input.count, model: ollama.textModel}),
    })

    const body = (await stored.json().catch(() => ({}))) as PracticeResponse

    if (!stored.ok) {
      throw new Error(body.error ?? 'Could not keep those practice questions.')
    }

    return body.created ?? 0
  }

  async function generate() {
    setBusy(true)
    setMessage(null)

    try {
      const response = await fetchJson(`/api/topics/${topicId}/practice`, {method: 'POST'})
      const body = (await response.json().catch(() => ({}))) as PracticeResponse

      if (!response.ok) {
        throw new Error(body.error ?? 'Could not write practice questions. Try again.')
      }

      let created = body.created ?? 0
      if (body.runsHere && body.input && body.ollama) {
        created = await writeHere(body.input, body.ollama)
      }

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
        className="rounded-xl border border-rule bg-surface px-3 py-1.5 text-sm hover:border-accent hover:bg-accent/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
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
