'use client'

import {useRef, useState} from 'react'
import {useRouter} from 'next/navigation'

import {OllamaProvider} from '@/lib/ai/ollama'
import {embedInBrowser} from '@/lib/client/ingest'
import {explainOllamaFailure} from '@/lib/client/http'
import {type AIProvider, type TopicCandidate, validated} from '@/lib/ai/types'

type SortableWorksheet = {
  id: string
  title: string
}

type OllamaSettings = {
  baseUrl: string
  visionModel: string
  textModel: string
}

type PendingResponse = {
  supported: boolean
  executor: string
  remaining: number
  questions: {id: string; promptText: string}[]
  ollama: OllamaSettings | null
}

type ShortlistResponse = {
  batch: {
    questionId: string
    promptText: string
    candidates: TopicCandidate[]
  }[]
}

type AppliedResponse = {
  applied: number
  done: boolean
}

const NO_PROVIDER =
  'Sorting questions into topics is not available for this account right now.'

async function pending(worksheetId: string) {
  const response = await fetch('/api/worksheets/' + worksheetId + '/classify')

  if (!response.ok) {
    throw new Error('Could not ask the server which questions still need a topic.')
  }

  return (await response.json()) as PendingResponse
}

async function send(worksheetId: string, body: unknown) {
  const response = await fetch('/api/worksheets/' + worksheetId + '/classify', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    let problem = 'The server refused a batch of questions.'

    try {
      const detail = (await response.json()) as {error?: string}
      if (detail.error) problem = detail.error
    } catch {
      problem = 'The server refused a batch of questions.'
    }

    throw new Error(problem)
  }

  return response.json()
}

async function pickHere(
  worksheetId: string,
  provider: AIProvider,
  items: {questionId: string; embedding: number[]}[],
) {
  const shortlist = (await send(worksheetId, {action: 'shortlist', items})) as ShortlistResponse

  let results = []

  for (let entry of shortlist.batch) {
    try {
      const classification = await provider.classifyTopic(entry.promptText, entry.candidates)

      results.push({
        questionId: entry.questionId,
        classification,
        candidates: entry.candidates,
      })
    } catch (error) {
      console.warn('[tier-c] question ' + entry.questionId + ' could not be sorted:', error)
    }
  }

  if (results.length === 0) {
    return {applied: 0, done: false}
  }

  return (await send(worksheetId, {action: 'apply', results})) as AppliedResponse
}

export function TopicSorter({
  worksheets,
  label,
}: {
  worksheets: SortableWorksheet[]
  label: string
}) {
  const [phase, setPhase] = useState('idle')
  const [message, setMessage] = useState('')
  const [done, setDone] = useState(0)
  const [total, setTotal] = useState(0)
  const [sortedCount, setSortedCount] = useState(0)

  const running = useRef(false)
  const ollamaBaseUrl = useRef('http://localhost:11434')
  const router = useRouter()

  async function run() {
    let totalPending = 0
    let runsHere = false
    let onGpu = false
    let ollama: OllamaSettings | null = null

    for (let worksheet of worksheets) {
      const first = await pending(worksheet.id)

      if (!first.supported) throw new Error(NO_PROVIDER)

      runsHere = first.executor === 'browser'
      onGpu = first.executor !== 'browser' && first.executor !== 'server'
      ollama = first.ollama

      if (ollama) ollamaBaseUrl.current = ollama.baseUrl
      totalPending = totalPending + first.remaining
    }

    if (totalPending === 0) {
      setSortedCount(0)
      setPhase('done')
      router.refresh()
      return
    }

    if (onGpu) {
      for (let worksheet of worksheets) {
        await send(worksheet.id, {items: []})
      }

      setPhase('queued')
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

    setPhase('sorting')
    setDone(0)
    setTotal(totalPending)

    let sorted = 0
    let seen = 0

    for (let worksheet of worksheets) {
      let attempted = new Set<string>()

      while (true) {
        const batch = await pending(worksheet.id)

        let todo = []
        for (let question of batch.questions) {
          if (!attempted.has(question.id)) todo.push(question)
        }

        if (todo.length === 0) break

        let items = []
        for (let question of todo) {
          attempted.add(question.id)
          items.push({
            questionId: question.id,
            embedding: await embedInBrowser(question.promptText),
          })
        }

        let applied
        if (provider) {
          applied = await pickHere(worksheet.id, provider, items)
        } else {
          applied = (await send(worksheet.id, {items})) as AppliedResponse
        }

        sorted = sorted + applied.applied

        seen = seen + items.length
        if (seen > totalPending) seen = totalPending
        setDone(seen)

        if (applied.done) break
      }
    }

    if (sorted === 0) {
      setPhase('error')
      setMessage(
        'None of these could be sorted just now. Nothing was changed, so you can try again.',
      )
      return
    }

    setSortedCount(sorted)
    setPhase('done')
    router.refresh()
  }

  function start() {
    if (running.current) return
    running.current = true
    setPhase('preparing')

    run()
      .catch((error: unknown) => {
        setPhase('error')
        setMessage(explainOllamaFailure(error, ollamaBaseUrl.current))
      })
      .finally(() => {
        running.current = false
      })
  }

  if (worksheets.length === 0) return null

  if (phase === 'done') {
    let text = 'Everything here already has a topic.'

    if (sortedCount > 0) {
      let word = 'questions'
      if (sortedCount === 1) word = 'question'

      text =
        'Sorted ' +
        sortedCount +
        ' ' +
        word +
        ' into topics. Accuracy by topic will fill in from here.'
    }

    return (
      <p role="status" className="hint text-pretty">
        {text}
      </p>
    )
  }

  if (phase === 'error') {
    return (
      <div className="text-pretty">
        <p role="alert" className="text-sm text-danger">
          {message}
        </p>
        <button
          type="button"
          onClick={start}
          className="btn btn-secondary mt-3 sm:w-auto sm:px-4"
        >
          Try again
        </button>
      </div>
    )
  }

  if (phase === 'idle') {
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

  if (phase === 'queued') {
    return (
      <p role="status" aria-live="polite" className="hint text-pretty">
        Queued for the GPU that sorts these. Safe to close: the topics appear once it
        has worked through them.
      </p>
    )
  }

  let text = 'Loading the sorting model in your browser. The first time takes a moment.'

  if (phase === 'sorting') {
    let at = done + 1
    if (at > total) at = total
    text = 'Sorting question ' + at + ' of ' + total + '.'
  }

  return (
    <p role="status" aria-live="polite" className="hint text-pretty">
      {text} <strong className="font-medium text-fg">Keep this tab open.</strong>
    </p>
  )
}
