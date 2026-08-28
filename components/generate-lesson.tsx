'use client'

import {useRouter} from 'next/navigation'
import {useState} from 'react'

import {OllamaProvider} from '@/lib/ai/ollama'
import {fetchJson} from '@/lib/client/http'
import {type LessonInput, validated} from '@/lib/ai/types'

type LessonResponse = {
  error?: string
  runsHere?: boolean
  input?: LessonInput
  ollama?: {baseUrl: string; textModel: string}
  status?: string
  writerOnline?: boolean
}

async function readBody(response: Response) {
  try {
    return (await response.json()) as LessonResponse
  } catch {
    return {} as LessonResponse
  }
}

export function GenerateLessonButton({topicId}: {topicId: string}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [queued, setQueued] = useState<string | null>(null)

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

    const stored = await fetchJson('/api/topics/' + topicId + '/lesson', {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({lesson, model: ollama.textModel}),
    })

    if (!stored.ok) {
      const detail = await readBody(stored)
      let message = detail.error
      if (!message) message = 'Could not save that lesson. Try again.'
      throw new Error(message)
    }
  }

  async function generate() {
    setBusy(true)
    setError(null)

    try {
      const response = await fetchJson('/api/topics/' + topicId + '/lesson', {method: 'POST'})
      const body = await readBody(response)

      if (!response.ok) {
        let message = body.error
        if (!message) message = 'Could not generate that lesson. Try again.'
        throw new Error(message)
      }

      if (body.status === 'queued') {
        if (body.writerOnline === false) {
          setQueued(
            'The GPU that writes these is not running right now. This is saved, and the lesson appears here once it is back.',
          )
        } else {
          setQueued('Queued for the GPU that writes these. It appears here once it is written.')
        }
        return
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

  let buttonText = 'Generate lesson overview'
  if (busy) buttonText = 'Writing…'

  let hint = 'Written by a model, from questions in this topic. Takes a moment.'
  if (queued) hint = queued
  if (error) hint = error

  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          generate()
        }}
        className="card px-3 py-1.5 text-sm hover:border-accent hover:bg-accent/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
      >
        {buttonText}
      </button>
      <p aria-live="polite" className="hint">
        {hint}
      </p>
    </div>
  )
}
