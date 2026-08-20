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

type Tally = Record<Rating, number>

const NO_TALLY: Tally = { again: 0, hard: 0, good: 0, easy: 0 }

/*
 * The run.
 *
 * Only `again` breaks it. That is not leniency, it is what the scheduler
 * already believes: `again` is the single rating FSRS treats as a lapse, and
 * `hard` is a recall that took a while, not a failure. A run that broke on
 * `hard` would be telling the student the opposite of what the algorithm
 * behind the app is doing with the same button.
 */
function extendsRun(rating: Rating): boolean {
  return rating !== 'again'
}

const RUN_COLOUR: Record<Rating, string> = {
  again: 'bg-danger',
  hard: 'bg-caution',
  good: 'bg-success',
  easy: 'bg-accent',
}

function minutesSince(start: number): string {
  const minutes = Math.round((Date.now() - start) / 60_000)
  if (minutes < 1) return 'under a minute'
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
}

const EXPLAIN_DEADLINE_MS = 3 * 60_000
const EXPLAIN_FIRST_WAIT_MS = 1_000
const EXPLAIN_MAX_WAIT_MS = 15_000
const EXPLAIN_BACKOFF = 1.6

const WRITER_OFFLINE =
  'The machine that writes these is not running right now, so this one has not ' +
  'started. Your request is saved and the explanation appears here once it is back.'

const WRITER_OFFLINE_AHEAD =
  'The machine that writes these is offline right now. Asking queues the ' +
  'explanation rather than writing it, and it appears here once it is back.'

const WRITER_SLOW =
  'This one is taking longer than usual. It is still queued, and it appears here ' +
  'once it is written.'

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
  writerOffline = false,
}: {
  items: ReviewItem[]
  topicName?: string | null
  writerOffline?: boolean
}) {
  const router = useRouter()

  const [index, setIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(0)
  const [explaining, setExplaining] = useState(false)
  const [explainError, setExplainError] = useState<string | null>(null)
  const [explainNotice, setExplainNotice] = useState<string | null>(null)
  const [generated, setGenerated] = useState<Record<string, string>>({})
  const [refreshing, setRefreshing] = useState(false)

  /*
   * Session bookkeeping for the run counter and the recap.
   *
   * Deliberately not persisted and deliberately not reset when the queue
   * refills mid-sitting, which matches `done` beside it: one sitting is one
   * visit to this page, however many batches of twenty it took. Leaving the
   * page ends the session, which is the behaviour a student expects from
   * something described as a run.
   */
  const [tally, setTally] = useState<Tally>(NO_TALLY)
  const [run, setRun] = useState(0)
  const [bestRun, setBestRun] = useState(0)
  /* Lazy initialiser rather than a ref: reading the clock is impure, and this
     is the one place React will run it exactly once and never during a
     re-render. */
  const [startedAt] = useState(() => Date.now())

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
  ): Promise<{ text: string } | { waiting: string }> {
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
        writerOnline?: boolean
      }

      if (body.status === 'ready' && body.explanation) {
        return { text: body.explanation.body }
      }

      if (body.status === 'none') {
        throw new Error('That explanation did not come through. Try again.')
      }

      if (body.status === 'queued' && body.writerOnline === false) {
        return { waiting: WRITER_OFFLINE }
      }
    }

    return { waiting: WRITER_SLOW }
  }

  async function explain(entry: ReviewItem) {
    explainAbort.current?.abort()
    const controller = new AbortController()
    explainAbort.current = controller

    setExplaining(true)
    setExplainError(null)
    setExplainNotice(null)

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
        writerOnline?: boolean
      }
      if (!response.ok && response.status !== 202) {
        throw new Error(body.error ?? 'Could not generate that.')
      }

      if (body.status === 'queued' && body.writerOnline === false) {
        setExplainNotice(WRITER_OFFLINE)
        return
      }

      const result = body.explanation
        ? { text: body.explanation.body }
        : await waitForExplanation(entry.questionId, controller.signal)

      if ('waiting' in result) {
        setExplainNotice(result.waiting)
        return
      }

      setGenerated((current) => ({ ...current, [entry.questionId]: result.text }))
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

        /* Counted only once the rating is saved, so a failed request cannot
           inflate a run the server never recorded. */
        setTally((current) => ({
          ...current,
          [rating]: current[rating] + 1,
        }))
        setRun((current) => {
          const next = extendsRun(rating) ? current + 1 : 0
          setBestRun((best) => Math.max(best, next))
          return next
        })

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
        <Recap
          done={done}
          bestRun={bestRun}
          tally={tally}
          startedAt={startedAt}
        />
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
      <div>
        <div
          role="progressbar"
          aria-valuenow={index}
          aria-valuemin={0}
          aria-valuemax={items.length}
          aria-label="Review progress"
          className="h-1 overflow-hidden bg-wash-strong"
        >
          <div
            className="h-full bg-fg transition-[width] duration-200"
            style={{ width: `${(index / items.length) * 100}%` }}
          />
        </div>

        <div className="mt-2 flex items-baseline justify-between gap-3">
          <p className="eyebrow">
            Question {index + 1} / {items.length}
          </p>

          {/*
            The run.

            Held back until it is worth having: a counter that reads "1" after
            every single answer is noise, and one that sits at zero while you
            are getting things wrong is just a scold. From two upwards it is
            something to keep going, which is the only reason it is here.

            `aria-hidden`, because the live region at the foot of the page
            already narrates progress and a number that changes on every
            answer would interrupt it to say the same thing twice.
          */}
          {run >= 2 && (
            <p aria-hidden="true" className="eyebrow text-fg">
              Run <span className="marked font-bold tabular-nums">{run}</span>
            </p>
          )}
        </div>
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
                      : ''
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
          <div className="mt-5 space-y-4 pt-4">
            <div>
              <h2 className="text-sm font-medium">Answer</h2>
              <p className="mt-1 text-sm">
                {correctChoice
                  ? `${correctChoice.label}. ${correctChoice.text}`
                  : (item.correctAnswer ?? 'No answer key was recorded.')}
              </p>

              {item.answerSource === 'ai_derived' && (
                <p className="mt-2 rounded-lg px-2 py-1 text-xs text-muted">
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
                    className="rounded-xl px-3 py-1.5 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
                    disabled={explaining}
                    onClick={() => void explain(item)}
                  >
                    {explaining ? 'Writing…' : writerOffline ? 'Ask for one' : 'Explain this'}
                  </button>
                  <p aria-live="polite" className="hint">
                    {explainError ??
                      explainNotice ??
                      (writerOffline
                        ? WRITER_OFFLINE_AHEAD
                        : 'Generated once, then saved. It uses your answer to target the mistake.')}
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
          className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger"
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
                className="flex flex-col items-center rounded-xl px-2 py-2 text-sm touch-manipulation hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
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

          <div className="mt-4 pt-3">
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

/*
 * The end of a sitting.
 *
 * This used to be one sentence and a button. A sitting is the thing the whole
 * app is arranged around, so it is worth printing properly: what the split
 * was, how long the best run got, and how long it took. The bar is the only
 * chart here because it is the only part that is easier to see than to read.
 */
function Recap({
  done,
  bestRun,
  tally,
  startedAt,
}: {
  done: number
  bestRun: number
  tally: Tally
  startedAt: number
}) {
  const rated = RATINGS.reduce((sum, rating) => sum + tally[rating.value], 0)
  const recalled = rated - tally.again

  return (
    <div className="card p-6 sm:p-8">
      <p className="eyebrow">Sitting complete</p>

      <p className="mt-2 font-display text-4xl font-semibold tabular-nums">
        {done} <span className="text-xl font-normal text-muted">reviewed</span>
      </p>

      {rated > 0 && (
        <>
          {/*
            One bar, four segments, in the order the buttons are in. Segments
            under 4% get a floor so a single `again` in a long sitting still
            leaves a visible mark rather than rounding away to nothing.
          */}
          <div
            aria-hidden="true"
            className="mt-5 flex h-2.5 w-full overflow-hidden "
          >
            {RATINGS.filter((rating) => tally[rating.value] > 0).map(
              (rating) => (
                <span
                  key={rating.value}
                  className={RUN_COLOUR[rating.value]}
                  style={{
                    width: `${Math.max((tally[rating.value] / rated) * 100, 4)}%`,
                  }}
                />
              ),
            )}
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
            {RATINGS.map((rating) => (
              <div key={rating.value} className="flex items-baseline gap-2">
                <span
                  aria-hidden="true"
                  className={`size-2 shrink-0 ${RUN_COLOUR[rating.value]}`}
                />
                <dt className="flex-1 text-sm text-muted">{rating.label}</dt>
                <dd className="font-mono text-sm font-bold tabular-nums">
                  {tally[rating.value]}
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}

      <p className="mt-5 pt-4 text-sm text-pretty">
        {recalled === rated && rated > 0 ? (
          <>You recalled every one of them.</>
        ) : (
          <>
            You recalled <span className="tabular-nums">{recalled}</span> of{' '}
            <span className="tabular-nums">{rated}</span> without having to
            start over.
          </>
        )}{' '}
        {bestRun >= 2 && (
          <>
            Your best run was{' '}
            <span className="marked font-bold tabular-nums">{bestRun}</span> in
            a row.{' '}
          </>
        )}
        That took {minutesSince(startedAt)}.
      </p>

      <div className="mt-5 flex flex-col gap-3 sm:flex-row">
        <Link href="/dashboard" className="btn btn-primary sm:w-auto sm:px-6">
          Back to dashboard
        </Link>
        <Link href="/worksheets" className="btn btn-secondary sm:w-auto sm:px-6">
          Your worksheets
        </Link>
      </div>
    </div>
  )
}
