'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { OllamaProvider } from '@/lib/ai/ollama'
import { explainOllamaFailure, fetchJson } from '@/lib/client/http'
import { reflowText } from '@/lib/questions/text'
import { type LessonInput, type PracticeInput } from '@/lib/ai/types'
import { validated } from '@/lib/ai/parse'
interface LessonResponse {
  error?: string
  runsHere?: boolean
  input?: LessonInput
  ollama?: { baseUrl: string; textModel: string }
}

export function GenerateLessonButton({ topicId }: { topicId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function writeHere(input: LessonInput, ollama: { baseUrl: string; textModel: string }) {
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lesson, model: ollama.textModel }),
    })

    if (!stored.ok) {
      const detail = (await stored.json().catch(() => ({}))) as { error?: string }
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
  ollama?: { baseUrl: string; textModel: string }
}

export function GeneratePracticeButton({ topicId }: { topicId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function writeHere(
    input: PracticeInput,
    ollama: { baseUrl: string; textModel: string },
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questions, count: input.count, model: ollama.textModel }),
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
  | { kind: 'worksheet'; worksheetId: string }
  | { kind: 'explanation'; questionId: string }

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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...target, message }),
      })

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string }
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
const WHEN = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

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

type Choice = { label: string; text: string }

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
}
