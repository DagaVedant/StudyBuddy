'use client'

import {useRef, useState} from 'react'
import {useRouter} from 'next/navigation'

import {embedInBrowser} from '@/lib/client/ingest'

type SortableWorksheet = {
  id: string
  title: string
}

type PendingResponse = {
  supported: boolean
  executor: string
  remaining: number
  questions: {id: string; promptText: string}[]
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
  const router = useRouter()

  async function run() {
    let totalPending = 0

    for (let worksheet of worksheets) {
      const first = await pending(worksheet.id)

      if (!first.supported) throw new Error(NO_PROVIDER)

      totalPending = totalPending + first.remaining
    }

    if (totalPending === 0) {
      setSortedCount(0)
      setPhase('done')
      router.refresh()
      return
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

        const applied = (await send(worksheet.id, {items})) as AppliedResponse

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
        setMessage((error as Error).message)
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
          The matching runs here rather than on our servers. The first run downloads a
          23MB sorting model, which your browser then keeps. Safe to leave: it picks up
          where it stopped.
        </p>
      </div>
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
