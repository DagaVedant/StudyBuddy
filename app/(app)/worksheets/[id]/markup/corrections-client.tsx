'use client'

import { useId, useState } from 'react'

import { fetchJson } from '@/lib/client/fetch-json'

export type Outcome = 'correct' | 'unsure' | 'wrong'

export interface MarkedQuestion {
  id: string
  ordinal: number
  promptText: string
  outcome: Outcome
  selectedChoiceId: string | null
  choices: { id: string; label: string; text: string }[]
}

const OUTCOMES: { value: Outcome; label: string }[] = [
  { value: 'correct', label: 'Got it' },
  { value: 'unsure', label: 'Unsure' },
  { value: 'wrong', label: 'Missed it' },
]

export default function CorrectionsClient({
  worksheetId,
  questions,
}: {
  worksheetId: string
  questions: MarkedQuestion[]
}) {
  const [marks, setMarks] = useState(() =>
    Object.fromEntries(
      questions.map((question) => [
        question.id,
        { outcome: question.outcome, selectedChoiceId: question.selectedChoiceId },
      ]),
    ),
  )
  const [saving, setSaving] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const groupId = useId()

  async function correct(
    questionId: string,
    next: { outcome: Outcome; selectedChoiceId: string | null },
  ) {
    const previous = marks[questionId]

    setMarks((current) => ({ ...current, [questionId]: next }))
    setSaving(questionId)
    setError(null)
    setSaved(null)

    try {
      const response = await fetchJson(`/api/worksheets/${worksheetId}/attempts`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId, ...next }),
      })

      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as {
          error?: string
        } | null
        throw new Error(detail?.error ?? 'That change did not save.')
      }

      setSaved(questionId)
    } catch (cause) {
      setMarks((current) => ({ ...current, [questionId]: previous }))
      setError((cause as Error).message)
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <p
          role="alert"
          className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}

      <ul className="space-y-3">
        {questions.map((question) => {
          const mark = marks[question.id]
          const wantsAnswer = mark.outcome === 'wrong' || mark.outcome === 'unsure'

          return (
            <li key={question.id} className="card p-4">
              <p className="text-sm text-pretty">
                <span className="text-muted tabular-nums">{question.ordinal}.</span>{' '}
                {question.promptText}
              </p>

              <fieldset className="mt-3">
                <legend className="sr-only">
                  How you did on question {question.ordinal}
                </legend>
                <div className="grid grid-cols-3 gap-2">
                  {OUTCOMES.map((outcome) => {
                    const isCurrent = mark.outcome === outcome.value

                    return (
                      <button
                        key={outcome.value}
                        type="button"
                        aria-pressed={isCurrent}
                        disabled={saving === question.id}
                        className={
                          isCurrent
                            ? 'min-h-11 rounded-xl border border-accent bg-accent/10 px-2 py-2 text-sm font-medium touch-manipulation focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
                            : 'min-h-11 rounded-xl  px-2 py-2 text-sm touch-manipulation hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60'
                        }
                        onClick={() =>
                          void correct(question.id, {
                            outcome: outcome.value,
                            selectedChoiceId:
                              outcome.value === 'correct' ? null : mark.selectedChoiceId,
                          })
                        }
                      >
                        {outcome.label}
                      </button>
                    )
                  })}
                </div>
              </fieldset>

              {wantsAnswer && question.choices.length > 0 && (
                <div className="mt-3">
                  <label
                    className="label"
                    htmlFor={`${groupId}-${question.id}`}
                  >
                    What you put
                  </label>
                  <select
                    id={`${groupId}-${question.id}`}
                    className="field"
                    disabled={saving === question.id}
                    value={mark.selectedChoiceId ?? ''}
                    onChange={(event) =>
                      void correct(question.id, {
                        outcome: mark.outcome,
                        selectedChoiceId: event.target.value || null,
                      })
                    }
                  >
                    <option value="">Not saying</option>
                    {question.choices.map((choice) => (
                      <option key={choice.id} value={choice.id}>
                        {choice.label}. {choice.text}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {saved === question.id && (
                <p role="status" className="hint">
                  Saved.
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
