'use client'

import Link from 'next/link'
import {useCallback, useEffect, useId, useMemo, useRef, useState} from 'react'
import {useFormStatus} from 'react-dom'
import {usePathname, useRouter} from 'next/navigation'

import {
  type AIProvider,
  type LessonInput,
  type PracticeInput,
  type TopicCandidate,
} from '@/lib/ai/types'
import {AccuracyLabel} from '@/components/ui'
import {OllamaProvider} from '@/lib/ai/ollama'
import {embedInBrowser} from '@/lib/client/ingest'
import {explainOllamaFailure, fetchJson} from '@/lib/client/http'
import {fetchPageImage} from '@/lib/client/ingest'
import {reflowText} from '@/lib/questions/shape'
import {type TopicTreeNode} from '@/lib/ranking'
import {validated} from '@/lib/ai/types'
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

export function TopicPicker({topics, value, onChange, disabled}: Props) {
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
      .map((topic) => ({topic, rank: score(topic, trimmed)}))
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
      ?.scrollIntoView({block: 'nearest'})
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
  coarse: number
  failed: number
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

  return response.json() as Promise<PendingResponse>
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

  return response.json() as Promise<unknown>
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
      setPhase({kind: 'done', sorted: 0})
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

    setPhase({kind: 'sorting', done: 0, total})

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
          : ((await send(worksheet.id, {items})) as AppliedResponse)

        sorted += applied.applied
        setPhase((current) =>
          current.kind === 'sorting'
            ? {kind: 'sorting', done: Math.min(current.done + items.length, total), total}
            : current,
        )

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
  const {batch} = (await send(worksheetId, {
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
    return {applied: 0, coarse: 0, failed: batch.length, done: false}
  }

  return (await send(worksheetId, {action: 'apply', results})) as AppliedResponse
}interface LessonResponse {
  error?: string
  runsHere?: boolean
  input?: LessonInput
  ollama?: {baseUrl: string; textModel: string}
}

export function GenerateLessonButton({topicId}: {topicId: string}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function writeHere(input: LessonInput, ollama: {baseUrl: string; textModel: string}) {
    const provider = validated(
      new OllamaProvider({
        baseUrl: ollama.baseUrl,
        visionModel: ollama.textModel,
        textModel: ollama.textModel,
        executionSite: 'browser',
      }),
    )

    const lesson = await provider.teachTopic(input)

    const stored = await fetchJson(`/api/topics/${topicId}/lesson`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({lesson, model: ollama.textModel}),
    })

    if (!stored.ok) {
      const detail = (await stored.json().catch(() => ({}))) as {error?: string}
      throw new Error(detail.error ?? 'Could not save that lesson. Try again.')
    }
  }

  async function generate() {
    setBusy(true)
    setError(null)

    try {
      const response = await fetchJson(`/api/topics/${topicId}/lesson`, {
        method: 'POST',
      })
      const body = (await response.json().catch(() => ({}))) as LessonResponse

      if (!response.ok) {
        throw new Error(body.error ?? 'Could not generate that lesson. Try again.')
      }

      if (body.runsHere && body.input && body.ollama) {
        await writeHere(body.input, body.ollama)
      }

      router.refresh()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={() => void generate()}
        className="rounded-xl px-3 py-1.5 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
      >
        {busy ? 'Writing…' : 'Generate lesson overview'}
      </button>
      <p aria-live="polite" className="hint">
        {error ?? 'Written by a model, from questions in this topic. Takes a moment.'}
      </p>
    </div>
  )
}
interface PracticeResponse {
  error?: string
  created?: number
  runsHere?: boolean
  input?: PracticeInput
  ollama?: {baseUrl: string; textModel: string}
}

export function GeneratePracticeButton({topicId}: {topicId: string}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function writeHere(
    input: PracticeInput,
    ollama: {baseUrl: string; textModel: string},
  ): Promise<number> {
    setMessage('Your machine is writing them. Keep this tab open.')

    const provider = validated(
      new OllamaProvider({
        baseUrl: ollama.baseUrl,
        visionModel: ollama.textModel,
        textModel: ollama.textModel,
        executionSite: 'browser',
      }),
    )

    const questions = await provider
      .writePractice(input)
      .catch((cause: unknown) => {
        throw new Error(explainOllamaFailure(cause, ollama.baseUrl))
      })

    const stored = await fetchJson(`/api/topics/${topicId}/practice`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({questions, count: input.count, model: ollama.textModel}),
    })

    const body = (await stored.json().catch(() => ({}))) as PracticeResponse

    if (!stored.ok) {
      throw new Error(body.error ?? 'Could not keep those practice questions.')
    }

    return body.created ?? 0
  }

  async function generate() {
    setBusy(true)
    setMessage(null)

    try {
      const response = await fetchJson(`/api/topics/${topicId}/practice`, {
        method: 'POST',
      })
      const body = (await response.json().catch(() => ({}))) as PracticeResponse

      if (!response.ok) {
        throw new Error(body.error ?? 'Could not write practice questions. Try again.')
      }

      const created =
        body.runsHere && body.input && body.ollama
          ? await writeHere(body.input, body.ollama)
          : (body.created ?? 0)

      setMessage(
        `${created} new ${created === 1 ? 'question' : 'questions'} added to your review queue.`,
      )
      router.refresh()
    } catch (cause) {
      setMessage((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={() => void generate()}
        className="rounded-xl px-3 py-1.5 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
      >
        {busy ? 'Writing…' : 'Write me practice questions'}
      </button>
      <p aria-live="polite" className="hint">
        {message ??
          'Four new questions on this topic, written by a model and dropped into your review queue.'}
      </p>
    </div>
  )
}
type Target =
  | {kind: 'worksheet'; worksheetId: string}
  | {kind: 'explanation'; questionId: string}

export function ReportButton({
  target,
  label = 'Report a problem',
  placeholder = 'What went wrong?',
}: {
  target: Target
  label?: string
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send() {
    setSending(true)
    setError(null)

    try {
      const response = await fetchJson('/api/reports', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({...target, message}),
      })

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {error?: string}
        throw new Error(body.error ?? 'That did not send.')
      }

      setSent(true)
      setOpen(false)
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setSending(false)
    }
  }

  if (sent) {
    return (
      <p aria-live="polite" className="hint">
        Thanks. That is on the list to look at.
      </p>
    )
  }

  if (!open) {
    return (
      <button
        type="button"
        className="text-xs text-muted underline underline-offset-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
    )
  }

  return (
    <div className="space-y-2">
      <label className="block">
        <span className="sr-only">{placeholder}</span>
        <textarea
          autoFocus
          rows={3}
          value={message}
          placeholder={placeholder}
          onChange={(event) => setMessage(event.target.value)}
          maxLength={2000}
          className="w-full rounded-xl bg-transparent px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        />
      </label>

      <div className="flex gap-2">
        <button
          type="button"
          disabled={sending}
          onClick={() => void send()}
          className="rounded-xl px-3 py-1.5 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
        >
          {sending ? 'Sending…' : 'Send report'}
        </button>
        <button
          type="button"
          disabled={sending}
          onClick={() => setOpen(false)}
          className="rounded-xl px-3 py-1.5 text-sm text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Cancel
        </button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
const WHEN = new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric'})

const OUTCOME_STYLE: Record<string, string> = {
  wrong: 'border-danger text-danger',
  unsure: 'border-caution text-caution',
  correct: 'border-success text-success',
}

const OUTCOME_LABEL: Record<string, string> = {
  wrong: 'Missed',
  unsure: 'Unsure',
  correct: 'Got it',
}

type Choice = {label: string; text: string}

export interface RevisitQuestionProps {
  promptText: string
  outcome: string
  answeredAt: Date
  worksheetTitle: string
  chosen?: Choice
  correct?: Choice
  freeText: string | null
}

export function RevisitQuestion({
  promptText,
  outcome,
  answeredAt,
  worksheetTitle,
  chosen,
  correct,
  freeText,
}: RevisitQuestionProps) {
  const [revealed, setRevealed] = useState(false)
  const hasAnswerDetail = Boolean(chosen || correct || freeText)

  return (
    <li className="card p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 flex-1 whitespace-pre-line text-sm">
          {reflowText(promptText)}
        </p>
        <span
          className={`shrink-0 border px-2 py-0.5 text-xs ${
            OUTCOME_STYLE[outcome] ?? 'text-muted'
          }`}
        >
          {OUTCOME_LABEL[outcome] ?? outcome}
        </span>
      </div>

      {hasAnswerDetail && (
        <div className="mt-2">
          {!revealed ? (
            <button
              type="button"
              className="btn-compact touch-manipulation rounded-xl px-1 text-xs text-muted underline underline-offset-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              onClick={() => setRevealed(true)}
            >
              Show answer
            </button>
          ) : (
            <p className="text-xs text-muted">
              You put{' '}
              <span className="text-danger">
                {chosen ? `${chosen.label}. ${chosen.text}` : freeText}
              </span>
              {correct && (
                <>
                  {' · answer '}
                  <span className="text-success">
                    {correct.label}. {correct.text}
                  </span>
                </>
              )}
            </p>
          )}
        </div>
      )}

      <p className="mt-1 text-xs text-muted">
        {worksheetTitle} · {WHEN.format(answeredAt)}
      </p>
    </li>
  )
}const NAV = [
  {href: '/dashboard', label: 'Dashboard'},
  {href: '/worksheets', label: 'Worksheets'},
  {href: '/review', label: 'Review'},
  {href: '/topics', label: 'Topics'},
  {href: '/settings', label: 'Settings'},
]

export function NavLinks() {
  const pathname = usePathname()

  return (
    <nav aria-label="Main" className="min-w-0 flex-1">
      <ul className="flex flex-wrap items-center gap-1 text-sm md:justify-center">
        {NAV.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`)

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`block whitespace-nowrap px-3 py-2 font-mono text-[0.6875rem] uppercase tracking-[0.12em] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                  active
                    ? 'font-bold text-fg'
                    : 'font-normal text-muted hover:text-fg'
                }`}
              >
                {item.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
function GoogleMark() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24s.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  )
}

export function GoogleButton({label}: {label: string}) {
  const {pending} = useFormStatus()

  return (
    <button type="submit" className="btn btn-google" aria-busy={pending}>
      <GoogleMark />
      {label}
    </button>
  )
}
const INTERVAL_MS = 60_000

export function AutoRefresh() {
  const router = useRouter()

  useEffect(() => {
    let last = Date.now()

    const refresh = () => {
      last = Date.now()
      router.refresh()
    }

    const tick = setInterval(() => {
      if (!document.hidden) refresh()
    }, INTERVAL_MS)

    const onVisible = () => {
      if (!document.hidden && Date.now() - last >= INTERVAL_MS) refresh()
    }

    document.addEventListener('visibilitychange', onVisible)

    return () => {
      clearInterval(tick)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [router])

  return null
}
const IDLE_POLL_MS = 5_000

interface SolvableQuestion {
  id: string
  promptText: string
  printedNumber: number | null
  pageImageKey: string | null
  choices: {label: string; text: string}[]
}

interface ExplainableQuestion {
  questionId: string
  attemptId: string | null
  promptText: string
  choices: {label: string; text: string}[]
  correctAnswer: string | null
  studentAnswer: string | null
}

interface Ollama {
  baseUrl: string
  visionModel: string
  textModel: string
}

interface Claim {
  job: {id: string; worksheetId: string; stage: string} | null
  solve?: SolvableQuestion[]
  explain?: ExplainableQuestion | null
  ollama?: Ollama
}

type RunnerPhase =
  | {kind: 'idle'}
  | {kind: 'solving'; done: number; total: number}
  | {kind: 'explaining'}
  | {kind: 'error'; message: string}

export function BrowserDerivedRunner() {
  const [phase, setPhase] = useState<RunnerPhase>({kind: 'idle'})

  const busy = useRef(false)
  const cancelled = useRef(false)

  const post = useCallback(async (jobId: string, body: unknown) => {
    const response = await fetch(`/api/browser-jobs/${jobId}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as {error?: string} | null
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
      setPhase({kind: 'solving', done: 0, total: pending.length})

      for (const [index, question] of pending.entries()) {
        if (cancelled.current) return

        try {
          let solution = await provider.answerQuestion({
            promptText: question.promptText,
            choices: question.choices,
          })

          if (solution.answer === null && question.pageImageKey) {
            const {image, mediaType} = await fetchPageImage(question.pageImageKey)

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

        setPhase({kind: 'solving', done: index + 1, total: pending.length})
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
      setPhase({kind: 'explaining'})

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
      {method: 'POST'},
    )

    if (response.status === 409 || !response.ok) return

    const {job, solve: pending, explain: input, ollama} = (await response.json()) as Claim
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

      await post(job.id, {action: 'complete'})
      setPhase({kind: 'idle'})
    } catch (error) {
      const message = explainOllamaFailure(error, ollama.baseUrl)
      setPhase({kind: 'error', message})
      await post(job.id, {action: 'fail', message}).catch(() => {})
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
