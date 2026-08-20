'use client'

import { useState } from 'react'

import { reflowText } from '@/lib/questions/text'

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

export default function RevisitQuestion({
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
