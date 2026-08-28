'use client'

import {useState} from 'react'

import {reflowText} from '@/lib/questions/shape'

type Choice = {label: string; text: string}

export function RevisitQuestion({
  promptText,
  outcome,
  answeredAt,
  worksheetTitle,
  chosen,
  correct,
  freeText,
}: {
  promptText: string
  outcome: string
  answeredAt: Date
  worksheetTitle: string
  chosen?: Choice
  correct?: Choice
  freeText: string | null
}) {
  const [revealed, setRevealed] = useState(false)

  let badgeStyle = 'text-muted'
  let badgeLabel = outcome

  if (outcome === 'wrong') {
    badgeStyle = 'border-danger text-danger'
    badgeLabel = 'Missed'
  }

  if (outcome === 'unsure') {
    badgeStyle = 'border-caution text-caution'
    badgeLabel = 'Unsure'
  }

  if (outcome === 'correct') {
    badgeStyle = 'border-success text-success'
    badgeLabel = 'Got it'
  }

  let hasAnswerDetail = false
  if (chosen || correct || freeText) hasAnswerDetail = true

  let yourAnswer = freeText
  if (chosen) yourAnswer = chosen.label + '. ' + chosen.text

  let when = answeredAt.toLocaleDateString(undefined, {month: 'short', day: 'numeric'})

  return (
    <li className="py-3 first:pt-0">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 flex-1 whitespace-pre-line text-sm">
          {reflowText(promptText)}
        </p>
        <span className={'shrink-0 border px-2 py-0.5 text-xs ' + badgeStyle}>
          {badgeLabel}
        </span>
      </div>

      {hasAnswerDetail && (
        <div className="mt-2">
          {!revealed && (
            <button
              type="button"
              className="btn-compact touch-manipulation rounded-xl px-1 text-xs text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              onClick={() => setRevealed(true)}
            >
              Show answer
            </button>
          )}

          {revealed && (
            <p className="text-xs text-muted">
              You put <span className="text-danger">{yourAnswer}</span>
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
        {worksheetTitle} · {when}
      </p>
    </li>
  )
}
