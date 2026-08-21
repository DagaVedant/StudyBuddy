'use client'

import Link from 'next/link'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { AccuracyLabel } from '@/components/ui'
import { OllamaProvider } from '@/lib/ai/ollama'
import { embedInBrowser } from '@/lib/client/embeddings'
import { explainOllamaFailure } from '@/lib/client/http'
import { type AIProvider, type TopicCandidate } from '@/lib/ai/types'
import { type TopicTreeNode } from '@/lib/ranking'
import { validated } from '@/lib/ai/parse'
export interface TopicChoice {
  id: string
  slug: string
  name: string
  path: string
}

interface Props {
  topics: TopicChoice[]
  value: string | null
  onChange: (topicId: string | null) => void
  disabled?: boolean
}

const MAX_RESULTS = 40

function score(topic: TopicChoice, query: string): number {
  const name = topic.name.toLowerCase()
  const path = topic.path.toLowerCase()

  if (name === query) return 0
  if (name.startsWith(query)) return 1
  if (name.includes(query)) return 2
  if (path.includes(query)) return 3
  return Number.POSITIVE_INFINITY
}

export function TopicPicker({ topics, value, onChange, disabled }: Props) {
  const inputId = useId()
  const listId = useId()

  const selected = useMemo(
    () => topics.find((topic) => topic.id === value) ?? null,
    [topics, value],
  )

  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const results = useMemo(() => {
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) return topics.slice(0, MAX_RESULTS)

    return topics
      .map((topic) => ({ topic, rank: score(topic, trimmed) }))
      .filter((entry) => Number.isFinite(entry.rank))
      .sort((a, b) => a.rank - b.rank || a.topic.path.localeCompare(b.topic.path))
      .slice(0, MAX_RESULTS)
      .map((entry) => entry.topic)
  }, [topics, query])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  function updateQuery(next: string) {
    setQuery(next)
    setActive(0)
  }

  function commit(topic: TopicChoice | null) {
    onChange(topic?.id ?? null)
    updateQuery('')
    setOpen(false)
  }

  return (
    <div ref={containerRef} className="relative">
      <span className="label" id={`${inputId}-label`}>
        Topic
      </span>

      {selected && !open ? (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate rounded-xl bg-surface px-3 py-2 text-sm">
            {selected.path}
          </span>
          <button
            type="button"
            className="btn-compact shrink-0 rounded px-2 text-sm text-muted underline underline-offset-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            disabled={disabled}
            onClick={() => {
              setOpen(true)
              requestAnimationFrame(() => document.getElementById(inputId)?.focus())
            }}
          >
            Change
          </button>
        </div>
      ) : (
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-labelledby={`${inputId}-label`}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && results[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          placeholder="Search topics, e.g. triangles…"
          className="field"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            updateQuery(event.target.value)
            setOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setOpen(true)
              setActive((index) => Math.min(index + 1, results.length - 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActive((index) => Math.max(index - 1, 0))
            } else if (event.key === 'Enter') {
              if (open && results[active]) {
                event.preventDefault()
                commit(results[active])
              }
            } else if (event.key === 'Escape') {
              setOpen(false)
            }
          }}
        />
      )}

      {open && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl bg-surface shadow-lg">
          {results.length === 0 && (
            <p className="px-3 py-2 text-sm text-muted">
              No topic matches that. Try a broader word, or leave it unset.
            </p>
          )}

          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Topics"
            className="max-h-64 overflow-y-auto"
          >
            {results.map((topic, index) => (
              <div
                key={topic.id}
                id={`${listId}-${index}`}
                data-index={index}
                role="option"
                aria-selected={index === active}
                className={`cursor-pointer px-3 py-2 text-left text-sm ${
                  index === active ? 'bg-accent/10' : ''
                }`}
                onPointerEnter={() => setActive(index)}
                onClick={() => commit(topic)}
              >
                <span className="block truncate font-medium">{topic.name}</span>
                <span className="block truncate text-xs text-muted">{topic.path}</span>
              </div>
            ))}
          </div>

          {selected && (
            <div className="">
              <button
                type="button"
                className="block w-full px-3 py-2 text-left text-sm text-muted hover:text-danger"
                onClick={() => commit(null)}
              >
                Clear topic
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
export function TopicTree({
  nodes,
  idBySlug,
  defaultOpenDepth = 0,
}: {
  nodes: TopicTreeNode[]
  idBySlug: ReadonlyMap<string, string>
  defaultOpenDepth?: number
}) {
  return (
    <ul className="space-y-1">
      {nodes.map((node) => (
        <li key={node.slug}>
          <TopicRow
            node={node}
            idBySlug={idBySlug}
            defaultOpenDepth={defaultOpenDepth}
          />
        </li>
      ))}
    </ul>
  )
}

function TopicRow({
  node,
  idBySlug,
  defaultOpenDepth,
}: {
  node: TopicTreeNode
  idBySlug: ReadonlyMap<string, string>
  defaultOpenDepth: number
}) {
  const topicId = idBySlug.get(node.slug)

  const label = (
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      <span className="min-w-0 flex-1 truncate text-sm">{node.name}</span>
      {node.attempts > 0 ? (
        <AccuracyLabel
          accuracy={node.accuracy ?? 0}
          ranked={node.ranked}
          attempts={node.attempts}
        />
      ) : (
        <span className="shrink-0 text-xs text-muted">Not started</span>
      )}
    </span>
  )

  if (node.children.length === 0) {
    return (
      <div className="flex items-baseline gap-2 py-1">
        {topicId ? (
          <Link
            href={`/topics/${topicId}`}
            className="flex min-w-0 flex-1 items-baseline gap-2 rounded hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {label}
          </Link>
        ) : (
          label
        )}
      </div>
    )
  }

  return (
    <details open={node.depth < defaultOpenDepth} className="group">
      <summary className="flex cursor-pointer items-baseline gap-2 rounded py-1 marker:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
        <span
          aria-hidden="true"
          className="shrink-0 text-xs text-muted transition-transform group-open:rotate-90"
        >
          ▶
        </span>
        {label}
      </summary>

      <div className="ml-3 border-l pl-3">
        <TopicTree
          nodes={node.children}
          idBySlug={idBySlug}
          defaultOpenDepth={defaultOpenDepth}
        />
      </div>
    </details>
  )
}
export interface SortableWorksheet {
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
  batchSize: number
  remaining: number
  questions: { id: string; promptText: string }[]
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
  coarse: number
  failed: number
  done: boolean
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'preparing' }
  | { kind: 'sorting'; done: number; total: number }
  | { kind: 'done'; sorted: number }
  | { kind: 'error'; message: string }

const NO_PROVIDER =
  'Sorting questions into topics needs a cloud API key or your own Ollama. Add one in settings.'

async function pending(worksheetId: string): Promise<PendingResponse> {
  const response = await fetch(`/api/worksheets/${worksheetId}/classify`)

  if (!response.ok) {
    throw new Error('Could not ask the server which questions still need a topic.')
  }

  return response.json() as Promise<PendingResponse>
}

async function send(worksheetId: string, body: unknown): Promise<unknown> {
  const response = await fetch(`/api/worksheets/${worksheetId}/classify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      error?: string
    } | null
    throw new Error(detail?.error ?? 'The server refused a batch of questions.')
  }

  return response.json() as Promise<unknown>
}

export function TopicSorter({
  worksheets,
  label,
}: {
  worksheets: SortableWorksheet[]
  label: string
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const running = useRef(false)
  const ollamaBaseUrl = useRef('http://localhost:11434')
  const router = useRouter()

  const run = useCallback(async () => {
    let total = 0
    let executor: PendingResponse['executor'] = 'server'
    let ollama: OllamaSettings | null = null

    for (const worksheet of worksheets) {
      const first = await pending(worksheet.id)

      if (!first.supported) throw new Error(NO_PROVIDER)

      executor = first.executor
      ollama = first.ollama
      if (first.ollama) ollamaBaseUrl.current = first.ollama.baseUrl
      total += first.remaining
    }

    if (total === 0) {
      setPhase({ kind: 'done', sorted: 0 })
      router.refresh()
      return
    }

    let provider: AIProvider | null = null

    if (executor === 'browser') {
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

    setPhase({ kind: 'sorting', done: 0, total })

    let sorted = 0

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
          : ((await send(worksheet.id, { items })) as AppliedResponse)

        sorted += applied.applied
        setPhase((current) =>
          current.kind === 'sorting'
            ? { kind: 'sorting', done: Math.min(current.done + items.length, total), total }
            : current,
        )

        if (applied.done) break
      }
    }

    setPhase({ kind: 'done', sorted })
    router.refresh()
  }, [router, worksheets])

  const start = useCallback(() => {
    if (running.current) return
    running.current = true
    setPhase({ kind: 'preparing' })

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
  items: { questionId: string; embedding: number[] }[],
): Promise<AppliedResponse> {
  const { batch } = (await send(worksheetId, {
    action: 'shortlist',
    items,
  })) as ShortlistResponse

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
    return { applied: 0, coarse: 0, failed: batch.length, done: false }
  }

  return (await send(worksheetId, { action: 'apply', results })) as AppliedResponse
}
