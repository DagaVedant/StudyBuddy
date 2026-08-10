'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

import ReportButton from '@/components/report-button'
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

/**
 * How long the explanation poll waits, and how it spends that wait.
 *
 * The three minutes are unchanged; the request count is not. A flat two second
 * gap meant ninety GETs per explanation, nearly all of them asking a worker
 * that had not started writing yet, and the worker takes tens of seconds on a
 * cold model. Backing off spends the same three minutes in about seventeen
 * requests. The first wait stays short so an explanation that is already
 * cached still appears at once, and the cap keeps the tail from drifting so
 * far out that a finished answer sits unclaimed.
 */
const EXPLAIN_DEADLINE_MS = 3 * 60_000
const EXPLAIN_FIRST_WAIT_MS = 1_000
const EXPLAIN_MAX_WAIT_MS = 15_000
const EXPLAIN_BACKOFF = 1.6

/**
 * `setTimeout` that an abort can cut short.
 *
 * The poll used to hold a bare timer, so leaving the screen mid-generation did
 * not stop it: it kept waking up and fetching against a component that was no
 * longer mounted. Now that the gap grows to fifteen seconds, a sleep that
 * ignored the signal would also be fifteen seconds of delay before the loop
 * noticed it had been cancelled.
 */
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
  // True between rating the last card of a queue and its replacement landing.
  // Without it the completion card below announces the end of the session for
  // the length of a round trip, which is the same false claim the stale index
  // used to make permanent.
  const [refreshing, setRefreshing] = useState(false)

  const explainAbort = useRef<AbortController | null>(null)

  /**
   * What counts as a different queue, as opposed to merely a different array.
   *
   * Rating the last card refreshes the route and parks the index past the end
   * of the current queue, but the replacement `items` arrive a render or two
   * later. Twenty more due questions therefore landed on a screen that was
   * already showing the completion card, and it stayed there until the student
   * reloaded the page.
   *
   * The card ids are the signal, not the identity of the array:
   * `router.refresh()` hands this component a new array every time, so
   * resetting on reference would send a student who is fifteen questions in
   * back to question one, on any refresh at all. The same ids in the same
   * order mean the same queue, so the index survives. `done` survives either
   * way, because it counts the sitting rather than the batch.
   */
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

  /**
   * Waits for an explanation the GPU worker is generating.
   *
   * Trial accounts run on the operator's own machine, which this site cannot
   * call directly, so the answer is queued and collected. Polling is on GET
   * rather than POST so waiting does not spend the hourly request budget or
   * charge the trial quota again.
   *
   * The gap between asks grows: see the constants at the top of the file for
   * what that changed and what it deliberately did not.
   */
  async function waitForExplanation(
    questionId: string,
    signal: AbortSignal,
  ): Promise<string> {
    const deadline = Date.now() + EXPLAIN_DEADLINE_MS
    let wait = EXPLAIN_FIRST_WAIT_MS

    while (Date.now() < deadline) {
      // Clamped to what is left, so the last ask lands on the deadline rather
      // than up to fifteen seconds past it.
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
    // The ref holds at most one live controller. A second run that overwrote
    // it while the first was still polling would leave the unmount cleanup
    // above able to abort only the newer one, and the older poll would go on
    // fetching from a screen that is gone: the thing this is here to prevent.
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
      // An abort is this screen going away or a second run taking over, not a
      // failure to report. Nothing is lost once the POST is through: the job
      // is queued server side and the worker writes the explanation against
      // the question, so it is already on the card next time it comes round.
      if (controller.signal.aborted) return
      setExplainError((cause as Error).message)
    } finally {
      if (!controller.signal.aborted) setExplaining(false)
      if (explainAbort.current === controller) explainAbort.current = null
    }
  }

  const item = items[index]

  /*
   * The poll belongs to the card that started it.
   *
   * `explaining` and `explainError` are one pair of scalars for the whole
   * session, so a poll left running after the student rated and moved on kept
   * the next card's button disabled and reading "Writing…", and when it finally
   * timed out it painted its error under a question it was never about. The
   * request itself is safe to drop: the job is queued server side and the
   * worker writes the explanation either way, so coming back to the card finds
   * it waiting.
   */
  const currentQuestionId = item?.questionId
  const [explainFor, setExplainFor] = useState(currentQuestionId)

  // The flags reset during render, the same way the queue reset above does, so
  // the next card never paints with the previous one's "Writing…" on its
  // button. The request itself is dropped in the effect below: a ref is not
  // readable here.
  if (currentQuestionId !== explainFor) {
    setExplainFor(currentQuestionId)
    setExplaining(false)
    setExplainError(null)
  }

  /*
   * Drops the poll when the card changes, and on unmount.
   *
   * Cleanup keyed on the card, so moving on aborts the request the previous one
   * started. Safe to drop: the job is queued server side and the worker writes
   * the explanation either way, so coming back to that card finds it waiting.
   * Left running, it kept the next card's button disabled and reading
   * "Writing…", and when it eventually timed out it painted its error under a
   * question it was never about.
   */
  useEffect(() => {
    return () => {
      explainAbort.current?.abort()
      explainAbort.current = null
    }
  }, [currentQuestionId])

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

        setDone((count) => count + 1)

        if (index + 1 >= items.length) {
          setRefreshing(true)
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

  /*
   * Three different empty states, and the difference matters.
   *
   * Arriving with nothing due is not the same as finishing a session, and the
   * server cannot tell them apart: by the time it re-renders, both are an empty
   * queue. `done` is what separates them, which is why this component stays
   * mounted across the refresh rather than being swapped for a page of its own.
   */
  if (!item) {
    if (refreshing) {
      return (
        <div className="card p-6 text-center">
          <h2 className="font-medium">Finding your next questions…</h2>
          <p className="hint">
            You reviewed <span className="tabular-nums">{done}</span>{' '}
            {done === 1 ? 'question' : 'questions'} so far.
          </p>
          {/*
            The way out stays on screen while the refresh is in flight. If it
            never lands, this is the whole screen, and a student waiting on a
            request that failed should not need the back button to leave.
          */}
          <div className="mt-4 flex flex-col justify-center gap-3 sm:flex-row">
            <Link href="/dashboard" className="btn btn-primary sm:w-auto sm:px-6">
              Back to Dashboard
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
              Back to Dashboard
            </Link>
          </div>
        </div>
      )
    }

    // Arrived with nothing due. This used to be a separate page, and moving it
    // here is what keeps the component mounted through a refresh.
    return (
      <div className="card p-6 text-center">
        <h2 className="font-medium">Nothing due</h2>
        <p className="hint mx-auto max-w-sm text-pretty">
          Everything you are tracking is scheduled for later. Upload another
          worksheet, or come back when something comes up for review.
        </p>
        <div className="mt-4 flex flex-col justify-center gap-3 sm:flex-row">
          <Link href="/upload" className="btn btn-primary sm:w-auto sm:px-6">
            Upload a Worksheet
          </Link>
          <Link href="/dashboard" className="btn btn-secondary sm:w-auto sm:px-6">
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

        <p className="whitespace-pre-line text-pretty">{reflowText(item.promptText)}</p>

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
                <span className="text-xs tabular-nums text-muted">
                  {item.intervals[rating.value]}
                </span>
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
