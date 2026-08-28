'use client'

import {useEffect, useRef, useState} from 'react'

import {OllamaProvider} from '@/lib/ai/ollama'
import {explainOllamaFailure} from '@/lib/client/http'
import {fetchPageImage} from '@/lib/client/ingest'
import {type AIProvider, validated} from '@/lib/ai/types'

type SolvableQuestion = {
  id: string
  promptText: string
  printedNumber: number | null
  pageImageKey: string | null
  choices: {label: string; text: string}[]
}

type ExplainableQuestion = {
  questionId: string
  attemptId: string | null
  promptText: string
  choices: {label: string; text: string}[]
  correctAnswer: string | null
  studentAnswer: string | null
}

type Ollama = {
  baseUrl: string
  visionModel: string
  textModel: string
}

type Claim = {
  job: {id: string; worksheetId: string; stage: string} | null
  solve?: SolvableQuestion[]
  explain?: ExplainableQuestion | null
  ollama?: Ollama
}

export function BrowserDerivedRunner() {
  const [phase, setPhase] = useState('idle')
  const [message, setMessage] = useState('')
  const [done, setDone] = useState(0)
  const [total, setTotal] = useState(0)

  const busy = useRef(false)
  const cancelled = useRef(false)

  useEffect(() => {
    cancelled.current = false

    async function post(jobId: string, body: unknown) {
      const response = await fetch('/api/browser-jobs/' + jobId, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        let problem = 'The server refused the result (' + response.status + ').'

        try {
          const detail = (await response.json()) as {error?: string}
          if (detail.error) problem = detail.error
        } catch {
          problem = 'The server refused the result (' + response.status + ').'
        }

        throw new Error(problem)
      }

      return response.json()
    }

    async function solve(
      jobId: string,
      provider: AIProvider,
      model: string,
      pending: SolvableQuestion[],
    ) {
      setPhase('solving')
      setDone(0)
      setTotal(pending.length)

      for (let index = 0; index < pending.length; index++) {
        if (cancelled.current) return

        let question = pending[index]

        try {
          let solution = await provider.answerQuestion({
            promptText: question.promptText,
            choices: question.choices,
          })

          if (solution.answer === null && question.pageImageKey) {
            const page = await fetchPageImage(question.pageImageKey)

            solution = await provider.answerQuestion({
              promptText: question.promptText,
              choices: question.choices,
              image: page.image,
              mediaType: page.mediaType,
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
          console.warn('[tier-c] question ' + question.id + ' could not be solved:', error)
        }

        setDone(index + 1)
      }
    }

    async function explain(
      jobId: string,
      provider: AIProvider,
      model: string,
      input: ExplainableQuestion,
    ) {
      setPhase('explaining')

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
    }

    async function runOnce() {
      const response = await fetch('/api/browser-jobs/claim?stages=answer_key,explain', {
        method: 'POST',
      })

      if (!response.ok) return

      const claim = (await response.json()) as Claim
      const job = claim.job
      const ollama = claim.ollama

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
          let pending = claim.solve
          if (!pending) pending = []
          await solve(job.id, provider, ollama.textModel, pending)
        } else if (job.stage === 'explain') {
          if (!claim.explain) throw new Error('That question is no longer here to explain.')
          await explain(job.id, provider, ollama.textModel, claim.explain)
        }

        if (cancelled.current) return

        await post(job.id, {action: 'complete'})
        setPhase('idle')
      } catch (error) {
        const failure = explainOllamaFailure(error, ollama.baseUrl)
        setPhase('error')
        setMessage(failure)

        try {
          await post(job.id, {action: 'fail', message: failure})
        } catch {
          console.warn('[tier-c] could not report the failure')
        }
      }
    }

    function tick() {
      if (busy.current || cancelled.current) return
      busy.current = true

      runOnce()
        .catch((error: unknown) => {
          console.warn('[tier-c] could not take on work:', error)
        })
        .finally(() => {
          busy.current = false
        })
    }

    tick()
    let timer = setInterval(tick, 5000)

    return () => {
      cancelled.current = true
      clearInterval(timer)
    }
  }, [])

  if (phase === 'idle') return null

  if (phase === 'error') {
    return (
      <p
        role="status"
        className="fixed inset-x-0 bottom-0 z-30 bg-danger/10 px-4 py-2 text-center text-xs text-danger"
      >
        {message} Nothing is lost: whatever finished is saved, and this picks up again
        when you come back.
      </p>
    )
  }

  if (phase === 'explaining') {
    return (
      <p
        role="status"
        aria-live="polite"
        className="fixed inset-x-0 bottom-0 z-30 bg-bg px-4 py-2 text-center text-xs text-muted"
      >
        Ollama is writing an explanation on your machine. Keep this tab open.
      </p>
    )
  }

  let at = done + 1
  if (at > total) at = total

  return (
    <p
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-0 z-30 bg-bg px-4 py-2 text-center text-xs text-muted"
    >
      Ollama is working out answer {at} of {total} on your machine. Keep this tab open.
    </p>
  )
}
