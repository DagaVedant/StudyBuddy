'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { OllamaProvider } from '@/lib/ai/ollama'
import { validated } from '@/lib/ai/parse'
import type { AIProvider } from '@/lib/ai/types'
import { explainOllamaFailure } from '@/lib/client/http'
import { fetchPageImage } from '@/lib/client/ingest'

const IDLE_POLL_MS = 5_000

interface SolvableQuestion {
  id: string
  promptText: string
  printedNumber: number | null
  pageImageKey: string | null
  choices: { label: string; text: string }[]
}

interface ExplainableQuestion {
  questionId: string
  attemptId: string | null
  promptText: string
  choices: { label: string; text: string }[]
  correctAnswer: string | null
  studentAnswer: string | null
}

interface Ollama {
  baseUrl: string
  visionModel: string
  textModel: string
}

interface Claim {
  job: { id: string; worksheetId: string; stage: string } | null
  solve?: SolvableQuestion[]
  explain?: ExplainableQuestion | null
  ollama?: Ollama
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'solving'; done: number; total: number }
  | { kind: 'explaining' }
  | { kind: 'error'; message: string }

export default function BrowserDerivedRunner() {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  const busy = useRef(false)
  const cancelled = useRef(false)

  const post = useCallback(async (jobId: string, body: unknown) => {
    const response = await fetch(`/api/browser-jobs/${jobId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { error?: string } | null
      throw new Error(detail?.error ?? `The server refused the result (${response.status}).`)
    }

    return response.json() as Promise<unknown>
  }, [])

  const solve = useCallback(
    async (
      jobId: string,
      provider: AIProvider,
      model: string,
      pending: SolvableQuestion[],
    ) => {
      setPhase({ kind: 'solving', done: 0, total: pending.length })

      for (const [index, question] of pending.entries()) {
        if (cancelled.current) return

        try {
          let solution = await provider.answerQuestion({
            promptText: question.promptText,
            choices: question.choices,
          })

          if (solution.answer === null && question.pageImageKey) {
            const { image, mediaType } = await fetchPageImage(question.pageImageKey)

            solution = await provider.answerQuestion({
              promptText: question.promptText,
              choices: question.choices,
              image,
              mediaType,
            })
          }

          if (cancelled.current) return

          await post(jobId, {
            action: 'solution',
            questionId: question.id,
            answer: solution.answer,
            workingMd: solution.working,
            traps: solution.traps,
            confidence: solution.confidence,
            model,
          })
        } catch (error) {
          console.warn(`[tier-c] question ${question.id} could not be solved:`, error)
        }

        setPhase({ kind: 'solving', done: index + 1, total: pending.length })
      }
    },
    [post],
  )

  const explain = useCallback(
    async (
      jobId: string,
      provider: AIProvider,
      model: string,
      input: ExplainableQuestion,
    ) => {
      setPhase({ kind: 'explaining' })

      const explanation = await provider.explain({
        promptText: input.promptText,
        choices: input.choices,
        correctAnswer: input.correctAnswer,
        studentAnswer: input.studentAnswer,
      })

      if (cancelled.current) return

      await post(jobId, {
        action: 'explanation',
        questionId: input.questionId,
        attemptId: input.attemptId,
        bodyMd: explanation.body_md,
        misconceptionNote: explanation.misconception_note,
        model,
      })
    },
    [post],
  )

  const runOnce = useCallback(async () => {
    const response = await fetch(
      '/api/browser-jobs/claim?stages=answer_key,explain',
      { method: 'POST' },
    )

    if (response.status === 409 || !response.ok) return

    const { job, solve: pending, explain: input, ollama } = (await response.json()) as Claim
    if (!job || !ollama) return

    const provider = validated(
      new OllamaProvider({
        baseUrl: ollama.baseUrl,
        visionModel: ollama.visionModel,
        textModel: ollama.textModel,
        executionSite: 'browser',
      }),
    )

    try {
      if (job.stage === 'answer_key') {
        await solve(job.id, provider, ollama.textModel, pending ?? [])
      } else if (job.stage === 'explain') {
        if (!input) throw new Error('That question is no longer here to explain.')
        await explain(job.id, provider, ollama.textModel, input)
      }

      if (cancelled.current) return

      await post(job.id, { action: 'complete' })
      setPhase({ kind: 'idle' })
    } catch (error) {
      const message = explainOllamaFailure(error, ollama.baseUrl)
      setPhase({ kind: 'error', message })
      await post(job.id, { action: 'fail', message }).catch(() => {})
    }
  }, [explain, post, solve])

  useEffect(() => {
    cancelled.current = false

    const tick = () => {
      if (busy.current || cancelled.current) return
      busy.current = true

      void runOnce()
        .catch((error: unknown) => {
          console.warn('[tier-c] could not take on work:', error)
        })
        .finally(() => {
          busy.current = false
        })
    }

    tick()
    const timer = setInterval(tick, IDLE_POLL_MS)

    return () => {
      cancelled.current = true
      clearInterval(timer)
    }
  }, [runOnce])

  if (phase.kind === 'idle') return null

  if (phase.kind === 'error') {
    return (
      <p
        role="status"
        className="fixed inset-x-0 bottom-0 z-30 bg-danger/10 px-4 py-2 text-center text-xs text-danger"
      >
        {phase.message} Nothing is lost: whatever finished is saved, and this picks up
        again when you come back.
      </p>
    )
  }

  return (
    <p
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-0 z-30 bg-bg px-4 py-2 text-center text-xs text-muted"
    >
      {phase.kind === 'explaining'
        ? 'Ollama is writing an explanation on your machine. Keep this tab open.'
        : `Ollama is working out answer ${Math.min(phase.done + 1, phase.total)} of ${phase.total} on your machine. Keep this tab open.`}
    </p>
  )
}
