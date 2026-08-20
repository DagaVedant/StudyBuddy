'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { OllamaProvider } from '@/lib/ai/ollama'
import { validated } from '@/lib/ai/validated'
import { toPngBytes } from '@/lib/client/page-image'
import { isAnswerPage } from '@/lib/questions/answer-key'
import { seamAround } from '@/lib/questions/page-text'

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
    checkpoint: { donePages?: number[] } | null
  } | null
  pages?: ClaimedPage[]
  ollama?: { baseUrl: string; visionModel: string; textModel: string }
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'reading'; done: number; total: number }
  | { kind: 'finishing' }
  | { kind: 'done' }
  | { kind: 'error'; message: string }

export default function BrowserRunner({ worksheetId }: { worksheetId: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const router = useRouter()

  const started = useRef(false)
  const cancelled = useRef(false)

  const post = useCallback(async (jobId: string, body: unknown) => {
    const response = await fetch(`/api/browser-jobs/${jobId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { error?: string } | null
      throw new Error(detail?.error ?? `The server refused a page (${response.status}).`)
    }

    return response.json() as Promise<unknown>
  }, [])

  const run = useCallback(async () => {
    const claimResponse = await fetch('/api/browser-jobs/claim?stages=extract', {
      method: 'POST',
    })

    if (claimResponse.status === 409) {
      // No Ollama configured. Nothing to say here: the page already explains
      // the worksheet is queued, and settings is where this gets fixed.
      return
    }

    if (!claimResponse.ok) throw new Error('Could not ask the server for work.')

    const claim = (await claimResponse.json()) as Claim
    const { job, pages, ollama } = claim
    if (!job || !pages || !ollama) return

    // Only this worksheet's job. A student with two uploads in flight has one
    // status page per worksheet, and each should drive its own.
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

    setPhase({ kind: 'reading', done: done.size, total: pages.length })

    for (const page of todo) {
      if (cancelled.current) return

      // The paper's own answer key is not questions, and the model reads it as
      // questions regardless of the prompt. The server drops what comes off
      // one; skipping saves the call, exactly as the operator's worker does.
      if (isAnswerPage(page.ocrText ?? '')) {
        await post(job.id, {
          action: 'page_result',
          pageId: page.id,
          pageNumber: page.pageNumber,
          totalPages: pages.length,
          questions: [],
        })
        done.add(page.pageNumber)
        setPhase({ kind: 'reading', done: done.size, total: pages.length })
        continue
      }

      const imageResponse = await fetch(`/api/files/${page.imageKey}`)
      if (!imageResponse.ok) {
        throw new Error(`Could not load page ${page.pageNumber}.`)
      }

      const { image, mediaType } = await toPngBytes(await imageResponse.blob())

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
        // One page failing is not the job failing. The audit downstream sees a
        // gap in the printed numbering and can ask for it again; throwing here
        // would abandon the pages already read.
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
      setPhase({ kind: 'reading', done: done.size, total: pages.length })
    }

    if (cancelled.current) return

    setPhase({ kind: 'finishing' })
    await post(job.id, { action: 'complete' })
    setPhase({ kind: 'done' })

    // The worksheet has left `queued`, so the status page's own redirect now
    // has somewhere to send them.
    router.refresh()
  }, [post, router, worksheetId])

  useEffect(() => {
    if (started.current) return
    started.current = true
    cancelled.current = false

    void run().catch((error: unknown) => {
      setPhase({ kind: 'error', message: (error as Error).message })
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
