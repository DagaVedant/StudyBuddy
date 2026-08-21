'use client'

import {useCallback, useEffect, useRef, useState} from 'react'
import {useRouter} from 'next/navigation'

import {OllamaProvider} from '@/lib/ai/ollama'
import {fetchJson} from '@/lib/client/http'
import {isAnswerPage} from '@/lib/questions/shape'
import {seamAround} from '@/lib/questions/shape'
import {toPngBytes} from '@/lib/client/ingest'
import {validated} from '@/lib/ai/types'

interface ClaimedPage {
  id: string
  pageNumber: number
  imageKey: string
  ocrText: string | null
  width: number | null
  height: number | null
}

interface Claim {
  job: {
    id: string
    worksheetId: string
    stage: string
    checkpoint: {donePages?: number[]} | null
  } | null
  pages?: ClaimedPage[]
  ollama?: {baseUrl: string; visionModel: string; textModel: string}
}

type Phase =
  | {kind: 'idle'}
  | {kind: 'reading'; done: number; total: number}
  | {kind: 'finishing'}
  | {kind: 'done'}
  | {kind: 'error'; message: string}

export function BrowserRunner({worksheetId}: {worksheetId: string}) {
  const [phase, setPhase] = useState<Phase>({kind: 'idle'})
  const router = useRouter()

  const started = useRef(false)
  const cancelled = useRef(false)

  const post = useCallback(async (jobId: string, body: unknown) => {
    const response = await fetch(`/api/browser-jobs/${jobId}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as {error?: string} | null
      throw new Error(detail?.error ?? `The server refused a page (${response.status}).`)
    }

    return response.json() as Promise<unknown>
  }, [])

  const run = useCallback(async () => {
    const claimResponse = await fetch('/api/browser-jobs/claim?stages=extract', {
      method: 'POST',
    })

    if (claimResponse.status === 409) {
      return
    }

    if (!claimResponse.ok) throw new Error('Could not ask the server for work.')

    const claim = (await claimResponse.json()) as Claim
    const {job, pages, ollama} = claim
    if (!job || !pages || !ollama) return

    if (job.worksheetId !== worksheetId) return

    const provider = validated(
      new OllamaProvider({
        baseUrl: ollama.baseUrl,
        visionModel: ollama.visionModel,
        textModel: ollama.textModel,
        executionSite: 'browser',
      }),
    )

    const done = new Set(job.checkpoint?.donePages ?? [])
    const todo = pages.filter((page) => !done.has(page.pageNumber))

    setPhase({kind: 'reading', done: done.size, total: pages.length})

    for (const page of todo) {
      if (cancelled.current) return

      if (isAnswerPage(page.ocrText ?? '')) {
        await post(job.id, {
          action: 'page_result',
          pageId: page.id,
          pageNumber: page.pageNumber,
          totalPages: pages.length,
          questions: [],
        })
        done.add(page.pageNumber)
        setPhase({kind: 'reading', done: done.size, total: pages.length})
        continue
      }

      const imageResponse = await fetch(`/api/files/${page.imageKey}`)
      if (!imageResponse.ok) {
        throw new Error(`Could not load page ${page.pageNumber}.`)
      }

      const {image, mediaType} = await toPngBytes(await imageResponse.blob())

      let questions: unknown[] = []
      try {
        questions = await provider.extractQuestions({
          image,
          mediaType,
          text: page.ocrText ?? '',
          width: page.width ?? 0,
          height: page.height ?? 0,
          pageNumber: page.pageNumber,
          ...seamAround(pages, pages.indexOf(page)),
        })
      } catch (error) {
        console.warn(`[tier-c] page ${page.pageNumber} failed:`, error)
      }

      if (cancelled.current) return

      await post(job.id, {
        action: 'page_result',
        pageId: page.id,
        pageNumber: page.pageNumber,
        totalPages: pages.length,
        questions,
      })

      done.add(page.pageNumber)
      setPhase({kind: 'reading', done: done.size, total: pages.length})
    }

    if (cancelled.current) return

    setPhase({kind: 'finishing'})
    await post(job.id, {action: 'complete'})
    setPhase({kind: 'done'})

    router.refresh()
  }, [post, router, worksheetId])

  useEffect(() => {
    if (started.current) return
    started.current = true
    cancelled.current = false

    void run().catch((error: unknown) => {
      setPhase({kind: 'error', message: (error as Error).message})
    })

    return () => {
      cancelled.current = true
    }
  }, [run])

  if (phase.kind === 'idle' || phase.kind === 'done') return null

  if (phase.kind === 'error') {
    return (
      <p
        role="alert"
        className="mt-6 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger"
      >
        {phase.message} Your worksheet is safe: what was read so far is saved, and
        reopening this page picks up from there.
      </p>
    )
  }

  return (
    <p role="status" className="hint text-pretty">
      {phase.kind === 'finishing'
        ? 'Read. Sorting the questions into topics.'
        : `Reading page ${Math.min(phase.done + 1, phase.total)} of ${phase.total} on your own machine.`}{' '}
      <strong className="font-medium text-fg">Keep this tab open.</strong> Ollama runs
      here rather than on our servers, so closing it stops the reading. Nothing is
      lost if you do: it carries on from the last finished page.
    </p>
  )
}

export function GoManualButton({worksheetId}: {worksheetId: string}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function start() {
    setBusy(true)
    setError(null)

    try {
      const response = await fetchJson(`/api/worksheets/${worksheetId}/go-manual`, {
        method: 'POST',
      })

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {error?: string} | null
        throw new Error(body?.error ?? 'Could not switch to manual entry.')
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
        router.push(`/worksheets/${worksheetId}/check`)
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
          className="h-full bg-accent transition-[width] duration-500"
          style={{width: `${Math.max(percent, 4)}%`}}
        />
      </div>

      <p aria-live="polite" className="hint mt-4 text-pretty">
        {progress < READING_UNTIL
          ? `Reading your worksheet. ${found} ${found === 1 ? 'question' : 'questions'} found so far.`
          : progress < VERIFYING_UNTIL
            ? 'Checking every question was picked up, and going back over anything that was missed.'
            : 'Sorting the questions into topics.'}
      </p>
    </>
  )
}
