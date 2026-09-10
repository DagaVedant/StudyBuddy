'use client'

import {useRouter} from 'next/navigation'
import {useState} from 'react'

import {fetchJson} from '@/lib/client/http'

type LessonResponse = {
  error?: string
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

  async function generate() {
    setBusy(true)
    setError(null)

    try {
      const response = await fetchJson('/api/topics/' + topicId + '/lesson', {method: 'POST'})

      if (!response.ok) {
        const body = await readBody(response)

        let message = body.error
        if (!message) message = 'Could not generate that lesson. Try again.'
        throw new Error(message)
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
