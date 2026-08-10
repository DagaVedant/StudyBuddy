'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { reflowText } from '@/lib/questions/reflow'
import { fetchJson } from '@/lib/client/fetch-json'

export interface MarkableQuestion {
  id: string
  ordinal: number
  promptText: string
  questionType: string
  correctAnswer: string | null
  choices: { id: string; label: string; text: string }[]
}

type Outcome = 'correct' | 'unsure' | 'wrong'

interface Props {
  worksheetId: string
  questions: MarkableQuestion[]
}

const OUTCOMES: { value: Outcome; label: string; hint: string; key: string }[] = [
  { value: 'correct', label: 'Got It', hint: 'Right, and I knew it', key: '1' },
  { value: 'unsure', label: 'Unsure', hint: 'Right, but I guessed', key: '2' },
  { value: 'wrong', label: 'Missed It', hint: 'Wrong answer', key: '3' },
]

export default function MarkupClient({ worksheetId, questions }: Props) {
  const router = useRouter()

  const [phase, setPhase] = useState<'outcomes' | 'answers'>('outcomes')
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({})
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [cursor, setCursor] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const marked = Object.keys(outcomes).length
  const currentQuestion = questions[cursor]
  const missed = useMemo(
    () => questions.filter((question) => outcomes[question.id] === 'wrong'),
    [questions, outcomes],
  )

  const mark = useCallback(
    (questionId: string, outcome: Outcome, index: number) => {
      setOutcomes((current) => ({ ...current, [questionId]: outcome }))
      setCursor(Math.min(index + 1, questions.length - 1))
    },
    [questions.length],
  )

  useEffect(() => {
    if (phase !== 'outcomes') return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return

      const choice = OUTCOMES.find((outcome) => outcome.key === event.key)
      const question = questions[cursor]
      if (!choice || !question) return

      event.preventDefault()
      mark(question.id, choice.value, cursor)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [phase, cursor, questions, mark])

  async function submit() {
    setSubmitting(true)
    setError(null)

    const marks = questions
      .filter((question) => outcomes[question.id])
      .map((question) => {
        const answer = answers[question.id]
        const choice = question.choices.find((option) => option.id === answer)
        return {
          questionId: question.id,
          outcome: outcomes[question.id],
          selectedChoiceId: choice?.id ?? null,
          freeTextAnswer: choice ? null : (answer ?? null),
        }
      })

    try {
      const response = await fetchJson(`/api/worksheets/${worksheetId}/attempts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marks }),
      })
      const body = (await response.json()) as { next?: string; error?: string }
      // Already marked: the marks this form would write are the ones already
      // stored, so there is nothing to retry and nothing to warn about.
      if (response.status === 409) {
        router.push(body.next ?? '/dashboard')
        return
      }
      if (!response.ok) throw new Error(body.error ?? 'Could not save')
      router.push(body.next ?? '/dashboard')
    } catch (cause) {
      setSubmitting(false)
      setError(
        cause instanceof Error
          ? `${cause.message}. Your marks are still here. Try again.`
          : 'Could not save your marks. Try again.',
      )
    }
  }

  if (phase === 'answers') {
    return (
      <div className="space-y-6">
        <div className="card px-4 py-3">
          <h2 className="text-sm font-medium">
            What did you put for the{' '}
            <span className="tabular-nums">{missed.length}</span> you missed?
          </h2>
          <p className="hint">
            Optional, but it lets the explanation address your actual mistake
            instead of just re-solving the problem.
          </p>
        </div>

        <ul className="space-y-4">
          {missed.map((question) => (
            <li
              key={question.id}
              className="card p-4"
            >
              <p className="text-sm">
                <span className="tabular-nums text-muted">{question.ordinal}. </span>
                <span className="whitespace-pre-line">
                  {reflowText(question.promptText)}
                </span>
              </p>

              {question.choices.length > 0 ? (
                <fieldset className="mt-3">
                  <legend className="sr-only">
                    Your answer for question {question.ordinal}
                  </legend>
                  <div className="flex flex-wrap gap-2">
                    {question.choices.map((choice) => {
                      const active = answers[question.id] === choice.id
                      return (
                        <label
                          key={choice.id}
                          className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm touch-manipulation has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent ${
                            active
                              ? 'border-accent bg-accent/10'
                              : 'border-border hover:border-accent'
                          }`}
                        >
                          <input
                            type="radio"
                            name={`answer-${question.id}`}
                            className="sr-only"
                            checked={active}
                            onChange={() =>
                              setAnswers((current) => ({
                                ...current,
                                [question.id]: choice.id,
                              }))
                            }
                          />
                          <span className="font-medium">{choice.label}</span>
                          <span className="max-w-40 truncate text-muted">
                            {choice.text}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </fieldset>
              ) : (
                <div className="mt-3">
                  <label className="label" htmlFor={`answer-${question.id}`}>
                    Your answer
                  </label>
                  <input
                    id={`answer-${question.id}`}
                    type="text"
                    autoComplete="off"
                    className="field"
                    value={answers[question.id] ?? ''}
                    onChange={(event) =>
                      setAnswers((current) => ({
                        ...current,
                        [question.id]: event.target.value,
                      }))
                    }
                  />
                </div>
              )}
            </li>
          ))}
        </ul>

        {error && (
          <p
            role="alert"
            className="rounded-xl border border-danger/40 px-3 py-2 text-sm text-danger"
          >
            {error}
          </p>
        )}

        <div className="flex flex-col gap-3 sm:flex-row-reverse">
          <button
            type="button"
            className="btn btn-primary touch-manipulation sm:w-auto sm:px-6"
            disabled={submitting}
            onClick={() => void submit()}
          >
            {submitting ? 'Saving…' : 'Save and Finish'}
          </button>
          <button
            type="button"
            className="btn btn-secondary touch-manipulation sm:w-auto sm:px-6"
            disabled={submitting}
            onClick={() => setPhase('outcomes')}
          >
            Back
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div
        className="inset-safe-top sticky top-0 z-10 -mx-6 border-b border-border bg-bg px-6 py-3"
      >
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-medium">
            <span className="tabular-nums">{marked}</span> of{' '}
            <span className="tabular-nums">{questions.length}</span> marked
          </p>
          <p className="hidden text-xs text-muted sm:block">
            Keys <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> to mark quickly
          </p>
        </div>
        <div
          role="progressbar"
          aria-valuenow={marked}
          aria-valuemin={0}
          aria-valuemax={questions.length}
          aria-label="Questions marked"
          className="mt-2 h-1 overflow-hidden rounded bg-border"
        >
          <div
            className="h-full bg-accent transition-[width] duration-200"
            style={{ width: `${(marked / questions.length) * 100}%` }}
          />
        </div>
      </div>

      {marked >= questions.length ? (
        <div className="card p-6 text-center">
          <p className="font-medium">
            All <span className="tabular-nums">{questions.length}</span> marked.
          </p>
          <p className="hint">Ready to continue.</p>
        </div>
      ) : (
        currentQuestion && (
          <div className="rounded-2xl border-2 border-accent bg-surface p-4 shadow-[0_8px_20px_-14px_oklch(0%_0_0_/_0.35)]">
            <p className="text-sm text-muted">
              Question <span className="tabular-nums">{currentQuestion.ordinal}</span> of{' '}
              <span className="tabular-nums">{questions.length}</span>
            </p>
            <p className="mt-2 whitespace-pre-line">
              {reflowText(currentQuestion.promptText)}
            </p>

            <fieldset className="mt-4">
              <legend className="sr-only">
                Result for question {currentQuestion.ordinal}
              </legend>
              <div className="grid grid-cols-3 gap-2">
                {OUTCOMES.map((outcome) => (
                  <button
                    key={outcome.value}
                    type="button"
                    title={outcome.hint}
                    className="flex flex-col items-center rounded-xl border border-border px-2 py-3 text-center text-sm touch-manipulation hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    onClick={() => mark(currentQuestion.id, outcome.value, cursor)}
                  >
                    {outcome.label}
                    <span className="text-xs font-normal text-muted">{outcome.hint}</span>
                  </button>
                ))}
              </div>
            </fieldset>

            {cursor > 0 && (
              <button
                type="button"
                className="mt-4 text-sm text-muted underline underline-offset-2 hover:text-fg"
                onClick={() => setCursor((index) => Math.max(0, index - 1))}
              >
                Back
              </button>
            )}
          </div>
        )
      )}

      {error && (
        <p
          role="alert"
          className="rounded-xl border border-danger/40 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}

      <p aria-live="polite" className="sr-only">
        {marked} of {questions.length} questions marked
      </p>

      {marked >= questions.length && (
        <div className="flex flex-col gap-3 sm:flex-row-reverse">
          {missed.length > 0 ? (
            <button
              type="button"
              className="btn btn-primary touch-manipulation sm:w-auto sm:px-6"
              onClick={() => setPhase('answers')}
            >
              Next: what you put
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary touch-manipulation sm:w-auto sm:px-6"
              disabled={submitting}
              onClick={() => void submit()}
            >
              {submitting ? 'Saving…' : 'Save and Finish'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
