'use client'

import Link from 'next/link'
import {useCallback, useEffect, useState} from 'react'

import {QuestionCrop} from '@/components/question-crop'
import {ReportButton} from '@/components/report-button'
import {fetchJson} from '@/lib/client/http'
import {type QuestionEvidence, reflowText} from '@/lib/questions/shape'

const BULK_UNDO_WINDOW_MS = 12_000

export interface CheckableQuestion {
  id: string
  printedNumber: number | null
  ordinal: number
  pageNumber: number | null
  promptText: string
  choices: {label: string; text: string}[]
  userVerified: boolean
  concerns: string[]
  duplicateOf: {
    worksheetId: string
    worksheetTitle: string
    exact: boolean
  } | null
  evidence: QuestionEvidence | null
}

export function CheckClient({
  worksheetId,
  questions,
}: {
  worksheetId: string
  questions: CheckableQuestion[]
}) {
  const [verified, setVerified] = useState<Set<string>>(
    () => new Set(questions.filter((q) => q.userVerified).map((q) => q.id)),
  )
  const [index, setIndex] = useState(() => {
    const first = questions.findIndex((q) => !q.userVerified)
    return first === -1 ? 0 : first
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingBulk, setConfirmingBulk] = useState(false)
  const [bulkUndo, setBulkUndo] = useState<string[] | null>(null)

  const remaining = questions.filter((q) => !verified.has(q.id)).length
  const question = questions[index]
  const done = verified.size

  const rollBack = useCallback((ids: string[]) => {
    setError('That did not save. Your place is kept; try again.')
    setVerified((current) => {
      const rolled = new Set(current)
      for (const id of ids) rolled.delete(id)
      return rolled
    })
  }, [])

  const mark = useCallback(
    async (ids: string[]) => {
      setError(null)
      setSaving(true)

      setVerified((current) => new Set([...current, ...ids]))

      try {
        const outcomes = await Promise.all(
          ids.map(async (id) => {
            const response = await fetchJson(`/api/questions/${id}`, {
              method: 'PATCH',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({userVerified: true}),
            })
            return {id, ok: response.ok}
          }),
        )

        const failed = outcomes.filter((outcome) => !outcome.ok)
        if (failed.length > 0) rollBack(failed.map((outcome) => outcome.id))
      } catch {
        rollBack(ids)
      } finally {
        setSaving(false)
      }
    },
    [rollBack],
  )

  const acceptRemaining = useCallback(async () => {
    const ids = questions.filter((q) => !verified.has(q.id)).map((q) => q.id)
    if (ids.length === 0) return

    setError(null)
    setSaving(true)
    setVerified((current) => new Set([...current, ...ids]))

    try {
      const response = await fetchJson(
        `/api/worksheets/${worksheetId}/check-all`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({exclude: []}),
        },
      )
      if (!response.ok) {
        rollBack(ids)
      } else {
        setBulkUndo(ids)
      }
    } catch {
      rollBack(ids)
    } finally {
      setSaving(false)
    }
  }, [questions, verified, worksheetId, rollBack])

  const undoBulkAccept = useCallback(async () => {
    if (!bulkUndo) return
    const ids = bulkUndo

    setBulkUndo(null)
    setVerified((current) => {
      const rolled = new Set(current)
      for (const id of ids) rolled.delete(id)
      return rolled
    })

    try {
      const response = await fetchJson(`/api/worksheets/${worksheetId}/check-all`, {
        method: 'DELETE',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ids}),
      })
      if (!response.ok) {
        setVerified((current) => new Set([...current, ...ids]))
        setError('Could not undo that. Your questions are still marked checked.')
      }
    } catch {
      setVerified((current) => new Set([...current, ...ids]))
      setError('Could not undo that. Your questions are still marked checked.')
    }
  }, [bulkUndo, worksheetId])

  const advance = useCallback(
    (alsoChecked: string[] = []) => {
      setIndex((current) => {
        const total = questions.length
        if (total === 0) return current

        const checked = new Set([...verified, ...alsoChecked])

        for (let step = 1; step <= total; step += 1) {
          const next = (current + step) % total
          if (!checked.has(questions[next].id)) return next
        }

        return current
      })
    },
    [questions, verified],
  )

  const accept = useCallback(async () => {
    if (!question) return
    const id = question.id
    await mark([id])
    advance([id])
  }, [question, mark, advance])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return

      if (event.key === 'y' || event.key === 'Y') void accept()
      if (event.key === 'ArrowRight' || event.key === 'j') advance()
      if (event.key === 'ArrowLeft' || event.key === 'k') {
        setIndex((current) => Math.max(current - 1, 0))
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [accept, advance])

  useEffect(() => {
    if (!bulkUndo) return
    const timer = setTimeout(() => setBulkUndo(null), BULK_UNDO_WINDOW_MS)
    return () => clearTimeout(timer)
  }, [bulkUndo])

  if (questions.length === 0) {
    return <p className="hint">This worksheet has no questions to check.</p>
  }

  if (remaining === 0) {
    return (
      <div>
        <p className="font-medium">
          All {questions.length}{' '}
          {questions.length === 1 ? 'question' : 'questions'} checked.
        </p>

        {bulkUndo && (
          <p role="status" className="mt-3 flex flex-wrap items-center gap-x-2 text-sm">
            <span className="text-muted">
              {bulkUndo.length} {bulkUndo.length === 1 ? 'question' : 'questions'} accepted.
            </span>
            <button
              type="button"
              onClick={() => void undoBulkAccept()}
              className="btn-compact text-accent"
            >
              Undo
            </button>
          </p>
        )}

        <Link
          href={`/worksheets/${worksheetId}/edit`}
          className="btn btn-primary mt-4 inline-flex"
        >
          Back to the worksheet
        </Link>

        <div className="mt-4 pt-4">
          <ReportButton
            target={{kind: 'worksheet', worksheetId}}
            label="Something is wrong with this whole worksheet"
            placeholder="Missing questions, wrong pages, numbering off?"
          />
        </div>
      </div>
    )
  }

  const label = question.printedNumber ?? question.ordinal

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted tabular-nums">
          {done} of {questions.length} checked
        </span>
        <span className="text-muted tabular-nums">
          card {index + 1} of {questions.length}
        </span>
      </div>

      <div
        className="h-1.5 overflow-hidden bg-wash-strong"
        role="progressbar"
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={questions.length}
        aria-label="Questions checked"
      >
        <div
          className="h-full bg-fg"
          style={{width: `${(done / questions.length) * 100}%`}}
        />
      </div>

      {error && (
        <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <article className="space-y-4 border-t border-fg/20 pt-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 shrink-0 rounded bg-accent/10 px-2 py-0.5 text-sm font-medium tabular-nums text-accent">
            {label}
          </span>
          <div className="min-w-0 flex-1">
            <p className="whitespace-pre-line text-pretty">
              {reflowText(question.promptText)}
            </p>
            {question.pageNumber !== null && (
              <p className="hint mt-1">
                Read from page {question.pageNumber}
                {question.evidence ? ', shown below.' : '.'}
              </p>
            )}
          </div>
          {verified.has(question.id) && (
            <span className="shrink-0 text-xs text-muted">checked</span>
          )}
        </div>

        {question.choices.length > 0 && (
          <ul className="space-y-1.5">
            {question.choices.map((choice) => (
              <li key={choice.label} className="flex gap-2 text-sm">
                <span className="w-5 shrink-0 font-medium text-muted">{choice.label}</span>
                <span className="text-pretty">{choice.text}</span>
              </li>
            ))}
          </ul>
        )}

        {question.evidence && (
          <QuestionCrop
            image={question.evidence}
            alt={`Question ${label} as it appears on the page`}
          />
        )}

        {question.concerns.length > 0 && (
          <div className="rounded-xl border border-accent/40 bg-accent/5 px-3 py-2 text-sm">
            <p className="font-medium">Worth a closer look</p>
            <ul className="mt-1 space-y-0.5 text-muted">
              {question.concerns.map((concern) => (
                <li key={concern}>{concern}</li>
              ))}
            </ul>
          </div>
        )}

        {question.duplicateOf && (
          <div className="rounded-xl px-3 py-2 text-sm">
            <p className="font-medium">
              {question.duplicateOf.exact
                ? 'You already have this question'
                : 'This looks like one you already have'}
            </p>
            <p className="mt-1 text-muted">
              From{' '}
              <Link
                href={`/worksheets/${question.duplicateOf.worksheetId}`}
                className="hover:text-fg"
              >
                {question.duplicateOf.worksheetTitle}
              </Link>
              . Keeping both means reviewing it twice; that is fine if you meant to.
            </p>
          </div>
        )}
      </article>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void accept()}
          disabled={saving}
          className="btn btn-primary"
        >
          Looks right
        </button>
        <Link
          href={`/worksheets/${worksheetId}/edit?focus=${question.id}`}
          className="btn btn-secondary"
        >
          Something&rsquo;s wrong
        </Link>
        <button
          type="button"
          onClick={() => advance()}
          className="btn btn-secondary"
        >
          Skip
        </button>
      </div>

      <p className="hint">
        Press <kbd>Y</kbd> to accept, arrow keys to move. {remaining} left to check.
      </p>

      {bulkUndo ? (
        <p role="status" className="flex flex-wrap items-center gap-x-2 text-sm">
          <span className="text-muted">
            {bulkUndo.length} {bulkUndo.length === 1 ? 'question' : 'questions'} accepted.
          </span>
          <button
            type="button"
            onClick={() => void undoBulkAccept()}
            className="btn-compact text-accent"
          >
            Undo
          </button>
        </p>
      ) : confirmingBulk ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span>Accept all {remaining} without checking each one?</span>
          <button
            type="button"
            onClick={() => {
              setConfirmingBulk(false)
              void acceptRemaining()
            }}
            disabled={saving}
            className="btn-compact text-danger"
          >
            Yes, accept {remaining}
          </button>
          <button
            type="button"
            onClick={() => setConfirmingBulk(false)}
            className="btn-compact text-muted hover:text-fg"
          >
            Cancel
          </button>
        </p>
      ) : (
        <button
          type="button"
          onClick={() => setConfirmingBulk(true)}
          disabled={saving}
          className="btn-compact text-sm text-muted hover:text-accent"
        >
          Accept the remaining {remaining} as they are
        </button>
      )}

      <div className="pt-4">
        <ReportButton
          target={{kind: 'worksheet', worksheetId}}
          label="Something is wrong with this whole worksheet"
          placeholder="Missing questions, wrong pages, numbering off?"
        />
      </div>
    </div>
  )
}
