'use client'

import {useRouter} from 'next/navigation'
import {useState} from 'react'

import {fetchJson} from '@/lib/client/http'

type PracticeResponse = {
  error?: string
  created?: number
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

      let created = 0
      if (body.created) created = body.created

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
