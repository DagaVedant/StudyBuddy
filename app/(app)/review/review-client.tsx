'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

import ReportButton from '@/components/report-button'
import QuestionCrop from '@/components/question-crop'
import { reflowText } from '@/lib/questions/reflow'
import type { ReviewItem } from '@/lib/review/queue'
import { fetchJson } from '@/lib/client/fetch-json'

type Rating = 'again' | 'hard' | 'good' | 'easy'

const RATINGS: { value: Rating; label: string; hint: string; key: string }[] = [
  { value: 'again', label: 'Again', hint: 'No idea', key: '1' },
  { value: 'hard', label: 'Hard', hint: 'Got there slowly', key: '2' },
  { value: 'good', label: 'Good', hint: 'Knew it', key: '3' },
  { value: 'easy', label: 'Easy', hint: 'Instant', key: '4' },
]

const EXPLAIN_DEADLINE_MS = 3 * 60_000
const EXPLAIN_FIRST_WAIT_MS = 1_000
const EXPLAIN_MAX_WAIT_MS = 15_000
const EXPLAIN_BACKOFF = 1.6

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }

    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export default function ReviewSession({
  items,
  topicName,
}: {
  items: ReviewItem[]
  topicName?: string | null
}) {
  const router = useRouter()

  const [index, setIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(0)
  const [explaining, setExplaining] = useState(false)
  const [explainError, setExplainError] = useState<string | null>(null)
  const [generated, setGenerated] = useState<Record<string, string>>({})
  const [refreshing, setRefreshing] = useState(false)

  const explainAbort = useRef<AbortController | null>(null)

  const queueKey = items.map((entry) => entry.cardId).join('|')
  const [queueSeen, setQueueSeen] = useState(queueKey)

  if (queueKey !== queueSeen) {
    setQueueSeen(queueKey)
    setIndex(0)
    setRevealed(false)
    setRefreshing(false)
  }

  function explanationFor(entry: ReviewItem): string | null {
    return generated[entry.questionId] ?? entry.explanation?.body ?? null
  }

  async function waitForExplanation(
    questionId: string,
    signal: AbortSignal,
  ): Promise<string> {
    const deadline = Date.now() + EXPLAIN_DEADLINE_MS
    let wait = EXPLAIN_FIRST_WAIT_MS

    while (Date.now() < deadline) {
      await sleep(Math.min(wait, deadline - Date.now()), signal)
      wait = Math.min(wait * EXPLAIN_BACKOFF, EXPLAIN_MAX_WAIT_MS)

      const response = await fetchJson(
        `/api/explain?questionId=${encodeURIComponent(questionId)}`,
        { signal },
      )
      const body = (await response.json()) as {
        status?: 'ready' | 'queued' | 'none'
        explanation?: { body: string }
      }

      if (body.status === 'ready' && body.explanation) return body.explanation.body

      if (body.status === 'none') {
        throw new Error('That explanation did not come through. Try again.')
      }
    }

    throw new Error(
      'The tutor is taking longer than usual. It will be here when you come back to this question.',
    )
  }

  async function explain(entry: ReviewItem) {
    explainAbort.current?.abort()
    const controller = new AbortController()
    explainAbort.current = controller

    setExplaining(true)
    setExplainError(null)

    try {
      const response = await fetchJson('/api/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId: entry.questionId }),
        signal: controller.signal,
      })
      const body = (await response.json()) as {
        explanation?: { body: string }
        status?: string
        error?: string
      }
      if (!response.ok && response.status !== 202) {
        throw new Error(body.error ?? 'Could not generate that.')
      }

      const text =
        body.explanation?.body ??
        (await waitForExplanation(entry.questionId, controller.signal))

      setGenerated((current) => ({ ...current, [entry.questionId]: text }))
    } catch (cause) {
      if (controller.signal.aborted) return
      setExplainError((cause as Error).message)
    } finally {
      if (!controller.signal.aborted) setExplaining(false)
      if (explainAbort.current === controller) explainAbort.current = null
    }
  }

  const item = items[index]

  const currentQuestionId = item?.questionId
  const [explainFor, setExplainFor] = useState(currentQuestionId)

  if (currentQuestionId !== explainFor) {
    setExplainFor(currentQuestionId)
    setExplaining(false)
    setExplainError(null)
  }

  useEffect(() => {
    return () => {
      explainAbort.current?.abort()
      explainAbort.current = null
    }
  }, [currentQuestionId])

  const advance = useCallback(() => {
    setDone((count) => count + 1)

    if (index + 1 >= items.length) {
      setRefreshing(true)
      router.refresh()
      setIndex(items.length)
    } else {
      setIndex((current) => current + 1)
      setRevealed(false)
    }
  }, [index, items.length, router])

  const retire = useCallback(async () => {
    if (!item || busy) return
    setBusy(true)
    setError(null)

    try {
      const response = await fetchJson('/api/review/retire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId: item.cardId }),
      })
      if (!response.ok) throw new Error('Could not put that one away')

      advance()
    } catch {
      setError('Could not put that one away. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }, [item, busy, advance])

  const rate = useCallback(
    async (rating: Rating) => {
      if (!item || busy) return
      setBusy(true)
      setError(null)

      try {
        const response = await fetchJson('/api/review/rate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cardId: item.cardId, rating }),
        })
        if (!response.ok) throw new Error('Could not save that rating')

        advance()
      } catch {
        setError('Could not save that rating. Check your connection and try again.')
      } finally {
        setBusy(false)
      }
    },
    [item, busy, advance],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return

      if (!revealed && (event.key === ' ' || event.key === 'Enter')) {
        event.preventDefault()
        setRevealed(true)
        return
      }

      if (revealed) {
        const match = RATINGS.find((rating) => rating.key === event.key)
        if (match) {
          event.preventDefault()
          void rate(match.value)
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [revealed, rate])

  if (!item) {
    if (refreshing) {
      return (
        <div className="card p-6 text-center">
          <h2 className="font-medium">Finding your next questions…</h2>
          <p className="hint">
            You reviewed <span className="tabular-nums">{done}</span>{' '}
            {done === 1 ? 'question' : 'questions'} so far.
          </p>
          <div className="mt-4 flex flex-col justify-center gap-3 sm:flex-row">
            <Link href="/dashboard" className="btn btn-primary sm:w-auto sm:px-6">
              Back to dashboard
            </Link>
          </div>
        </div>
      )
    }

    if (done > 0) {
      return (
        <div className="card p-6 text-center">
          <h2 className="font-medium">Session complete</h2>
          <p className="hint">
            You reviewed <span className="tabular-nums">{done}</span>{' '}
            {done === 1 ? 'question' : 'questions'}.
          </p>
          <div className="mt-4 flex flex-col justify-center gap-3 sm:flex-row">
            <Link href="/dashboard" className="btn btn-primary sm:w-auto sm:px-6">
              Back to dashboard
            </Link>
          </div>
        </div>
      )
    }

    if (topicName) {
      return (
        <div className="card p-6 text-center">
          <h2 className="font-medium">Nothing due in {topicName}</h2>
          <p className="hint mx-auto max-w-sm text-pretty">
            Everything you are tracking under this topic is scheduled for later.
          </p>
          <div className="mt-4 flex flex-col justify-center gap-3 sm:flex-row">
            <Link href="/review" className="btn btn-primary sm:w-auto sm:px-6">
              Review everything due
            </Link>
            <Link href="/dashboard" className="btn btn-secondary sm:w-auto sm:px-6">
              Back to dashboard
            </Link>
          </div>
        </div>
      )
    }

    return (
      <div className="card p-6 text-center">
        <h2 className="font-medium">Nothing due</h2>
        <p className="hint mx-auto max-w-sm text-pretty">
          Everything you are tracking is scheduled for later. Upload another
          worksheet, or come back when something comes up for review.
        </p>
        <div className="mt-4 flex flex-col justify-center gap-3 sm:flex-row">
          <Link href="/upload" className="btn btn-primary sm:w-auto sm:px-6">
            Upload a worksheet
          </Link>
          <Link href="/dashboard" className="btn btn-secondary sm:w-auto sm:px-6">
            Back to dashboard
          </Link>
        </div>
      </div>
    )
  }

  const chosen = item.choices.find((choice) => choice.id === item.lastChoiceId)
  const correctChoice = item.choices.find((choice) => choice.isCorrect)

  return (
    <div className="space-y-4">
      <div
        role="progressbar"
        aria-valuenow={index}
        aria-valuemin={0}
        aria-valuemax={items.length}
        aria-label="Review progress"
        className="h-1 overflow-hidden rounded bg-border"
      >
        <div
          className="h-full bg-accent transition-[width] duration-200"
          style={{ width: `${(index / items.length) * 100}%` }}
        />
      </div>

      <article className="card p-5">
        {item.topicName && (
          <p className="mb-2 text-xs uppercase tracking-wide text-muted">
            {item.topicName}
          </p>
        )}

        <p className="whitespace-pre-line text-pretty">{reflowText(item.promptText)}</p>

        {item.evidence && (
          <div className="mt-3">
            <QuestionCrop image={item.evidence} alt="The question as it was printed" />
          </div>
        )}

        {item.choices.length > 0 && (
          <ul className="mt-4 space-y-1.5">
            {item.choices.map((choice) => (
              <li
                key={choice.id}
                className={`rounded-xl border px-3 py-2 text-sm ${
                  revealed && choice.isCorrect
                    ? 'border-success text-success'
                    : revealed && choice.id === item.lastChoiceId
                      ? 'border-danger text-danger'
                      : 'border-border'
                }`}
              >
                <span className="font-medium">{choice.label}.</span> {choice.text}
              </li>
            ))}
          </ul>
        )}

        {!revealed ? (
          <button
            type="button"
            className="btn btn-secondary mt-5 touch-manipulation"
            onClick={() => setRevealed(true)}
          >
            Show answer
          </button>
        ) : (
          <div className="mt-5 space-y-4 border-t border-border pt-4">
            <div>
              <h2 className="text-sm font-medium">Answer</h2>
              <p className="mt-1 text-sm">
                {correctChoice
                  ? `${correctChoice.label}. ${correctChoice.text}`
                  : (item.correctAnswer ?? 'No answer key was recorded.')}
              </p>

              {item.answerSource === 'ai_derived' && (
                <p className="mt-2 rounded-lg border border-border px-2 py-1 text-xs text-muted">
                  AI-derived, not from an answer key. Double-check it.
                </p>
              )}
            </div>

            {(chosen || item.lastFreeText) && (
              <div>
                <h2 className="text-sm font-medium">You put</h2>
                <p className="mt-1 text-sm text-muted">
                  {chosen ? `${chosen.label}. ${chosen.text}` : item.lastFreeText}
                </p>
              </div>
            )}

            <div>
              <h2 className="text-sm font-medium">Explanation</h2>
              {explanationFor(item) ? (
                <>
                  <p className="mt-1 whitespace-pre-line text-pretty text-sm">
                    {explanationFor(item)}
                  </p>
                  <div className="mt-2">
                    <ReportButton
                      target={{ kind: 'explanation', questionId: item.questionId }}
                      label="This explanation looks wrong"
                      placeholder="What is wrong with it?"
                    />
                  </div>
                </>
              ) : (
                <div className="mt-1">
                  <button
                    type="button"
                    className="rounded-xl border border-border px-3 py-1.5 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
                    disabled={explaining}
                    onClick={() => void explain(item)}
                  >
                    {explaining ? 'Writing…' : 'Explain this'}
                  </button>
                  <p aria-live="polite" className="hint">
                    {explainError ??
                      'Generated once, then saved. It uses your answer to target the mistake.'}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </article>

      {error && (
        <p
          role="alert"
          className="rounded-xl border border-danger/40 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}

      {revealed && (
        <div>
          <p className="hint mb-2">How well did you recall it?</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {RATINGS.map((rating) => (
              <button
                key={rating.value}
                type="button"
                disabled={busy}
                onClick={() => void rate(rating.value)}
                className="flex flex-col items-center rounded-xl border border-border px-2 py-2 text-sm touch-manipulation hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
              >
                <span className="font-medium">{rating.label}</span>
                <span className="text-xs text-muted">{rating.hint}</span>
                <span className="text-xs tabular-nums text-muted">
                  {item.intervals[rating.value]}
                </span>
              </button>
            ))}
          </div>
          <p className="hidden text-xs text-muted sm:mt-2 sm:block">
            Keys <kbd>1</kbd>–<kbd>4</kbd>, or <kbd>Space</kbd> to reveal
          </p>

          <div className="mt-4 border-t border-border pt-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => void retire()}
              className="btn-compact rounded-xl px-1 text-sm text-muted underline underline-offset-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
            >
              Got it, stop asking me this one
            </button>
            <p className="hint">
              It stays counted as one you missed, and stays in your Blooket
              export. It just leaves the practice queue.
            </p>
          </div>
        </div>
      )}

      <p aria-live="polite" className="sr-only">
        Question {index + 1} of {items.length}
        {revealed ? ', answer revealed' : ''}
      </p>
    </div>
  )
}
