'use client'

import {useEffect, useState} from 'react'
import {useRouter} from 'next/navigation'

import {fetchJson} from '@/lib/client/http'

export function GoManualButton({worksheetId}: {worksheetId: string}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function start() {
    setBusy(true)
    setError(null)

    try {
      const response = await fetchJson('/api/worksheets/' + worksheetId + '/go-manual', {
        method: 'POST',
      })

      if (!response.ok) {
        let message = 'Could not switch to manual entry.'

        try {
          const detail = (await response.json()) as {error?: string}
          if (detail.error) message = detail.error
        } catch {
          message = 'Could not switch to manual entry.'
        }

        throw new Error(message)
      }

      const body = (await response.json()) as {next: string}
      router.push(body.next)
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'Could not switch to manual entry.')
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={start}
        disabled={busy}
        className="btn btn-secondary sm:w-auto sm:px-6"
      >
        {busy ? 'Switching…' : 'Add questions manually instead'}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

const READING_UNTIL = 0.8
const VERIFYING_UNTIL = 0.95

export function SampleRunner({
  worksheetId,
  questionCount,
  holdMs,
}: {
  worksheetId: string
  questionCount: number
  holdMs: number
}) {
  const router = useRouter()
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const startedAt = Date.now()

    const tick = setInterval(() => {
      const next = Math.min(Date.now() - startedAt, holdMs)
      setElapsed(next)

      if (next >= holdMs) {
        clearInterval(tick)
        router.push('/worksheets/' + worksheetId + '/check')
      }
    }, 200)

    return () => clearInterval(tick)
  }, [holdMs, router, worksheetId])

  const progress = elapsed / holdMs
  const percent = Math.round(progress * 100)

  const found = Math.min(
    questionCount,
    Math.floor((progress / READING_UNTIL) * questionCount),
  )

  let message = 'Sorting the questions into topics.'

  if (progress < READING_UNTIL) {
    let noun = 'questions'
    if (found === 1) noun = 'question'

    message = 'Reading your worksheet. ' + found + ' ' + noun + ' found so far.'
  } else if (progress < VERIFYING_UNTIL) {
    message = 'Checking every question was picked up, and going back over anything that was missed.'
  }

  let barWidth = percent
  if (barWidth < 4) barWidth = 4

  return (
    <>
      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Extraction progress"
        className="mt-6 h-1.5 overflow-hidden rounded bg-wash-strong"
      >
        <div
          className="h-full bg-accent"
          style={{width: barWidth + '%'}}
        />
      </div>

      <p aria-live="polite" className="hint mt-4 text-pretty">
        {message}
      </p>
    </>
  )
}
