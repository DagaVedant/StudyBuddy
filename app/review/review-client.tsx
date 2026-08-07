'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'

import type { ReviewItem } from '@/lib/review/queue'

type Rating = 'again' | 'hard' | 'good' | 'easy'

const RATINGS: { value: Rating; label: string; hint: string; key: string }[] = [
  { value: 'again', label: 'Again', hint: 'No idea', key: '1' },
  { value: 'hard', label: 'Hard', hint: 'Got there slowly', key: '2' },
  { value: 'good', label: 'Good', hint: 'Knew it', key: '3' },
  { value: 'easy', label: 'Easy', hint: 'Instant', key: '4' },
]

export default function ReviewSession({ items }: { items: ReviewItem[] }) {
  const router = useRouter()

  const [index, setIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(0)
  const [explaining, setExplaining] = useState(false)
  const [explainError, setExplainError] = useState<string | null>(null)
  const [generated, setGenerated] = useState<Record<string, string>>({})

  function explanationFor(entry: ReviewItem): string | null {
    return generated[entry.questionId] ?? entry.explanation?.body ?? null
  }

  /**
   * Waits for an explanation the GPU worker is generating.
   *
   * Trial accounts run on the operator's own machine, which this site cannot
   * call directly, so the answer is queued and collected. Polling is on GET
   * rather than POST so waiting does not spend the hourly request budget or
   * charge the trial quota again.
   */
  async function waitForExplanation(questionId: string): Promise<string> {
    const deadline = Date.now() + 3 * 60_000

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000))

      const response = await fetch(
        `/api/explain?questionId=${encodeURIComponent(questionId)}`,
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
    setExplaining(true)
    setExplainError(null)

    try {
      const response = await fetch('/api/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId: entry.questionId }),
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
        body.explanation?.body ?? (await waitForExplanation(entry.questionId))

      setGenerated((current) => ({ ...current, [entry.questionId]: text }))
    } catch (cause) {
      setExplainError((cause as Error).message)
    } finally {
      setExplaining(false)
    }
  }

  const item = items[index]

  const rate = useCallback(
    async (rating: Rating) => {
      if (!item || busy) return
      setBusy(true)
      setError(null)

      try {
        const response = await fetch('/api/review/rate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cardId: item.cardId, rating }),
        })
        if (!response.ok) throw new Error('Could not save that rating')

        setDone((count) => count + 1)

        if (index + 1 >= items.length) {
          router.refresh()
          setIndex(items.length)
        } else {
          setIndex((current) => current + 1)
          setRevealed(false)
        }
      } catch {
        setError('Could not save that rating. Check your connection and try again.')
      } finally {
        setBusy(false)
      }
    },
    [item, busy, index, items.length, router],
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
    return (
      <div className="card p-6 text-center">
        <h2 className="font-medium">Session complete</h2>
        <p className="hint">
          You reviewed <span className="tabular-nums">{done}</span>{' '}
          {done === 1 ? 'question' : 'questions'}.
        </p>
        <div className="mt-4 flex flex-col justify-center gap-3 sm:flex-row">
          <Link href="/dashboard" className="btn btn-primary sm:w-auto sm:px-6">
            Back to Dashboard
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
          className="h-full bg-accent motion-safe:transition-[width] motion-safe:duration-200"
          style={{ width: `${(index / items.length) * 100}%` }}
        />
      </div>

      <article className="card p-5">
        {item.topicName && (
          <p className="mb-2 text-xs uppercase tracking-wide text-muted">
            {item.topicName}
          </p>
        )}

        <p className="whitespace-pre-line text-pretty">{item.promptText}</p>

        {item.figureImageKey && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/files/${item.figureImageKey}`}
            alt="Figure for this question"
            className="mt-4 max-h-64 w-auto rounded-xl border border-border"
          />
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
            Show Answer
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
                <p className="mt-1 whitespace-pre-line text-pretty text-sm">
                  {explanationFor(item)}
                </p>
              ) : (
                <div className="mt-1">
                  <button
                    type="button"
                    className="rounded-xl border border-border px-3 py-1.5 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
                    disabled={explaining}
                    onClick={() => void explain(item)}
                  >
                    {explaining ? 'Writing…' : 'Explain This'}
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
              </button>
            ))}
          </div>
          <p className="hidden text-xs text-muted sm:mt-2 sm:block">
            Keys <kbd>1</kbd>–<kbd>4</kbd>, or <kbd>Space</kbd> to reveal
          </p>
        </div>
      )}

      <p aria-live="polite" className="sr-only">
        Question {index + 1} of {items.length}
        {revealed ? ', answer revealed' : ''}
      </p>
    </div>
  )
}
