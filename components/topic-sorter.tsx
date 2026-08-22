'use client'

import {useCallback, useRef, useState} from 'react'
import {useRouter} from 'next/navigation'

import {OllamaProvider} from '@/lib/ai/ollama'
import {embedInBrowser} from '@/lib/client/ingest'
import {explainOllamaFailure} from '@/lib/client/http'
import {type AIProvider, type TopicCandidate, validated} from '@/lib/ai/types'

interface SortableWorksheet {
  id: string
  title: string
}

interface OllamaSettings {
  baseUrl: string
  visionModel: string
  textModel: string
}

interface PendingResponse {
  supported: boolean
  executor: 'server' | 'browser' | 'operator_gpu' | 'none'
  remaining: number
  questions: {id: string; promptText: string}[]
  ollama: OllamaSettings | null
}

interface ShortlistResponse {
  batch: {
    questionId: string
    promptText: string
    candidates: TopicCandidate[]
  }[]
}

interface AppliedResponse {
  applied: number
  done: boolean
}

type Phase =
  | {kind: 'idle'}
  | {kind: 'preparing'}
  | {kind: 'sorting'; done: number; total: number}
  | {kind: 'done'; sorted: number}
  | {kind: 'error'; message: string}

const NO_PROVIDER =
  'Sorting questions into topics needs a cloud API key or your own Ollama. Add one in settings.'

async function pending(worksheetId: string): Promise<PendingResponse> {
  const response = await fetch(`/api/worksheets/${worksheetId}/classify`)

  if (!response.ok) {
    throw new Error('Could not ask the server which questions still need a topic.')
  }

  return response.json()
}

async function send(worksheetId: string, body: unknown): Promise<unknown> {
  const response = await fetch(`/api/worksheets/${worksheetId}/classify`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      error?: string
    } | null
    throw new Error(detail?.error ?? 'The server refused a batch of questions.')
  }

  return response.json()
}

export function TopicSorter({
  worksheets,
  label,
}: {
  worksheets: SortableWorksheet[]
  label: string
}) {
  const [phase, setPhase] = useState<Phase>({kind: 'idle'})
  const running = useRef(false)
  const ollamaBaseUrl = useRef('http://localhost:11434')
  const router = useRouter()

  const run = useCallback(async () => {
    let total = 0
    let runsHere = false
    let ollama: OllamaSettings | null = null

    for (const worksheet of worksheets) {
      const first = await pending(worksheet.id)

      if (!first.supported) throw new Error(NO_PROVIDER)

      runsHere = first.executor === 'browser'
      ollama = first.ollama
      if (ollama) ollamaBaseUrl.current = ollama.baseUrl
      total += first.remaining
    }

    if (total === 0) {
      setPhase({kind: 'done', sorted: 0})
      router.refresh()
      return
    }

    let provider: AIProvider | null = null

    if (runsHere) {
      if (!ollama) throw new Error(NO_PROVIDER)

      provider = validated(
        new OllamaProvider({
          baseUrl: ollama.baseUrl,
          visionModel: ollama.visionModel,
          textModel: ollama.textModel,
          executionSite: 'browser',
        }),
      )
    }

    setPhase({kind: 'sorting', done: 0, total})

    let sorted = 0
    let seen = 0

    for (const worksheet of worksheets) {
      const attempted = new Set<string>()

      for (;;) {
        const batch = await pending(worksheet.id)

        const todo = batch.questions.filter((question) => !attempted.has(question.id))
        if (todo.length === 0) break

        const items = []
        for (const question of todo) {
          attempted.add(question.id)
          items.push({
            questionId: question.id,
            embedding: await embedInBrowser(question.promptText),
          })
        }

        const applied = provider
          ? await pickHere(worksheet.id, provider, items)
          : ((await send(worksheet.id, {items})) as AppliedResponse)

        sorted += applied.applied
        seen = Math.min(seen + items.length, total)
        setPhase({kind: 'sorting', done: seen, total})

        if (applied.done) break
      }
    }

    setPhase({kind: 'done', sorted})
    router.refresh()
  }, [router, worksheets])

  const start = useCallback(() => {
    if (running.current) return
    running.current = true
    setPhase({kind: 'preparing'})

    void run()
      .catch((error: unknown) => {
        setPhase({
          kind: 'error',
          message: explainOllamaFailure(error, ollamaBaseUrl.current),
        })
      })
      .finally(() => {
        running.current = false
      })
  }, [run])

  if (worksheets.length === 0) return null

  if (phase.kind === 'done') {
    return (
      <p role="status" className="hint text-pretty">
        {phase.sorted === 0
          ? 'Everything here already has a topic.'
          : `Sorted ${phase.sorted} ${phase.sorted === 1 ? 'question' : 'questions'} into topics. Accuracy by topic will fill in from here.`}
      </p>
    )
  }

  if (phase.kind === 'error') {
    return (
      <div className="text-pretty">
        <p role="alert" className="text-sm text-danger">
          {phase.message}
        </p>
        <button type="button" onClick={start} className="btn btn-secondary mt-3 sm:w-auto sm:px-4">
          Try again
        </button>
      </div>
    )
  }

  if (phase.kind === 'idle') {
    return (
      <div className="text-pretty">
        <button type="button" onClick={start} className="btn btn-primary sm:w-auto sm:px-4">
          {label}
        </button>
        <p className="hint">
          Runs here rather than on our servers. The first run downloads a 23MB sorting
          model, which your browser then keeps. Safe to leave: it picks up where it
          stopped.
        </p>
      </div>
    )
  }

  return (
    <p role="status" aria-live="polite" className="hint text-pretty">
      {phase.kind === 'preparing'
        ? 'Loading the sorting model in your browser. The first time takes a moment.'
        : `Sorting question ${Math.min(phase.done + 1, phase.total)} of ${phase.total}.`}{' '}
      <strong className="font-medium text-fg">Keep this tab open.</strong>
    </p>
  )
}

async function pickHere(
  worksheetId: string,
  provider: AIProvider,
  items: {questionId: string; embedding: number[]}[],
): Promise<AppliedResponse> {
  const {batch} = (await send(worksheetId, {action: 'shortlist', items})) as ShortlistResponse

  const results = []

  for (const entry of batch) {
    try {
      const classification = await provider.classifyTopic(
        entry.promptText,
        entry.candidates,
      )

      results.push({
        questionId: entry.questionId,
        classification,
        candidates: entry.candidates,
      })
    } catch (error) {
      console.warn(`[tier-c] question ${entry.questionId} could not be sorted:`, error)
    }
  }

  if (results.length === 0) {
    return {applied: 0, done: false}
  }

  return (await send(worksheetId, {action: 'apply', results})) as AppliedResponse
}
