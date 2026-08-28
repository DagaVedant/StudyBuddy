'use client'

import {useRouter} from 'next/navigation'
import {useState} from 'react'

import {OllamaProvider} from '@/lib/ai/ollama'
import {explainOllamaFailure, fetchJson} from '@/lib/client/http'
import {type PracticeInput, validated} from '@/lib/ai/types'

type PracticeResponse = {
  error?: string
  created?: number
  runsHere?: boolean
  input?: PracticeInput
  ollama?: {baseUrl: string; textModel: string}
  status?: string
  writerOnline?: boolean
}

async function readBody(response: Response) {
  try {
    return (await response.json()) as PracticeResponse
  } catch {
    return {} as PracticeResponse
  }
}

export function GeneratePracticeButton({topicId}: {topicId: string}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function writeHere(input: PracticeInput, ollama: {baseUrl: string; textModel: string}) {
    setMessage('Your machine is writing them. Keep this tab open.')

    const provider = validated(
      new OllamaProvider({
        baseUrl: ollama.baseUrl,
        visionModel: ollama.textModel,
        textModel: ollama.textModel,
        executionSite: 'browser',
      }),
    )

    let questions
    try {
      questions = await provider.writePractice(input)
    } catch (cause) {
      throw new Error(explainOllamaFailure(cause, ollama.baseUrl))
    }

    const stored = await fetchJson('/api/topics/' + topicId + '/practice', {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({questions, count: input.count, model: ollama.textModel}),
    })

    const body = await readBody(stored)

    if (!stored.ok) {
      let problem = body.error
      if (!problem) problem = 'Could not keep those practice questions.'
      throw new Error(problem)
    }

    if (!body.created) return 0
    return body.created
  }

  async function generate() {
    setBusy(true)
    setMessage(null)

    try {
      const response = await fetchJson('/api/topics/' + topicId + '/practice', {method: 'POST'})
      const body = await readBody(response)

      if (!response.ok) {
        let problem = body.error
        if (!problem) problem = 'Could not write practice questions. Try again.'
        throw new Error(problem)
      }

      if (body.status === 'queued') {
        if (body.writerOnline === false) {
          setMessage(
            'The GPU that writes these is not running right now. This is saved, and they land in your review queue once it is back.',
          )
        } else {
          setMessage(
            'Queued for the GPU that writes these. They land in your review queue once they are written.',
          )
        }
        return
      }

      let created = 0
      if (body.created) created = body.created

      if (body.runsHere && body.input && body.ollama) {
        created = await writeHere(body.input, body.ollama)
      }

      let word = 'questions'
      if (created === 1) word = 'question'

      setMessage(created + ' new ' + word + ' added to your review queue.')
      router.refresh()
    } catch (cause) {
      setMessage((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }

  let buttonText = 'Write me practice questions'
  if (busy) buttonText = 'Writing…'

  let hint =
    'Four new questions on this topic, written by a model and dropped into your review queue.'
  if (message) hint = message

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
