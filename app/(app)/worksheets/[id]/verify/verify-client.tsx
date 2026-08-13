'use client'

import QuestionCrop from '@/components/question-crop'
import type { QuestionEvidence } from '@/lib/questions/evidence'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'

import ReportButton from '@/components/report-button'
import { fetchJson } from '@/lib/client/fetch-json'
import { reflowText } from '@/lib/questions/reflow'

/** The scan a question was read off, and where on it the reader found it. */
export interface VerifiableQuestion {
  id: string
  printedNumber: number | null
  ordinal: number
  pageNumber: number | null
  promptText: string
  choices: { label: string; text: string }[]
  userVerified: boolean
  /** Why the checks doubted this one. Empty when nothing was flagged. */
  concerns: string[]
  /**
   * The same question, already in the library from another worksheet, or null.
   * Shown rather than acted on: spec §6.3 offers a merge here and never makes
   * one silently, because a wrong guess costs the student a question they
   * never see again.
   */
  duplicateOf: {
    worksheetId: string
    worksheetTitle: string
    /** Content hashes agree, so the two read identically. */
    exact: boolean
  } | null
  /**
   * Null when the question has no page, no box, or the page never recorded its
   * own size. Any of those means the crop cannot be placed on the scan, and a
   * misplaced crop is worse than none on a screen whose whole job is comparing
   * against the paper.
   */
  evidence: QuestionEvidence | null
}

export function VerifyClient({
  worksheetId,
  questions,
}: {
  worksheetId: string
  questions: VerifiableQuestion[]
}) {
  const [verified, setVerified] = useState<Set<string>>(
    () => new Set(questions.filter((q) => q.userVerified).map((q) => q.id)),
  )
  const [index, setIndex] = useState(() => {
    // Resume where they stopped rather than making them walk past work they
    // have already done.
    const first = questions.findIndex((q) => !q.userVerified)
    return first === -1 ? 0 : first
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remaining = useMemo(
    () => questions.filter((q) => !verified.has(q.id)).length,
    [questions, verified],
  )

  const question = questions[index]
  const done = verified.size

  /** Takes back the optimistic tick for questions that did not save. */
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

      // Shown as accepted straight away. The student is answering faster than
      // a round trip and a card that lags behind the keypress feels broken.
      setVerified((current) => new Set([...current, ...ids]))

      try {
        // `fetchJson` hands 404s and 500s back untouched, so a promise that
        // resolved is not a question that saved. Nothing looked at `ok` here,
        // which meant a deleted or failing question kept its tick and the
        // student left believing it was stored.
        const outcomes = await Promise.all(
          ids.map(async (id) => {
            const response = await fetchJson(`/api/questions/${id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userVerified: true }),
            })
            return { id, ok: response.ok }
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

  /**
   * Everything still unchecked, in one request.
   *
   * This used to be one PATCH per question: on the 114-question benchmark
   * paper, 114 requests queued against a five-connection pool, with most of
   * them still in flight when the student followed the button to the next
   * screen.
   */
  const acceptRemaining = useCallback(async () => {
    const ids = questions.filter((q) => !verified.has(q.id)).map((q) => q.id)
    if (ids.length === 0) return

    setError(null)
    setSaving(true)
    setVerified((current) => new Set([...current, ...ids]))

    try {
      const response = await fetchJson(
        `/api/worksheets/${worksheetId}/verify-all`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // No exclusions: skipping a card leaves it in the remaining count,
          // and this button says it accepts the remaining ones.
          body: JSON.stringify({ exclude: [] }),
        },
      )
      if (!response.ok) rollBack(ids)
    } catch {
      rollBack(ids)
    } finally {
      setSaving(false)
    }
  }, [questions, verified, worksheetId, rollBack])

  const advance = useCallback(() => {
    setIndex((current) => Math.min(current + 1, questions.length - 1))
  }, [questions.length])

  const accept = useCallback(async () => {
    if (!question) return
    await mark([question.id])
    advance()
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

  if (questions.length === 0) {
    return <p className="hint">This worksheet has no questions to check.</p>
  }

  if (remaining === 0) {
    return (
      <div className="card p-6">
        <p className="font-medium">
          All {questions.length}{' '}
          {questions.length === 1 ? 'question' : 'questions'} checked.
        </p>
        <p className="hint mt-1">Nothing left to confirm on this worksheet.</p>
        <Link
          href={`/worksheets/${worksheetId}/review`}
          className="btn btn-primary mt-4 inline-flex"
        >
          Back to the worksheet
        </Link>

        {/* Also here, not only beside the cards. Having just checked every
            question against the paper is the moment a student is best placed
            to say the reading missed whole ones, and this screen is where
            they land to find out there were only three. */}
        <div className="mt-4 border-t border-border pt-4">
          <ReportButton
            target={{ kind: 'worksheet', worksheetId }}
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
        className="h-1.5 w-full overflow-hidden rounded-full bg-border"
        role="progressbar"
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={questions.length}
        aria-label="Questions checked"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-200"
          style={{ width: `${(done / questions.length) * 100}%` }}
        />
      </div>

      {error && (
        <p role="alert" className="rounded-xl border border-danger/40 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <article className="card space-y-4 p-5">
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

        {/* After the choices, because it is what both the prompt and the
            options get checked against. */}
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
          <div className="rounded-xl border border-border px-3 py-2 text-sm">
            <p className="font-medium">
              {question.duplicateOf.exact
                ? 'You already have this question'
                : 'This looks like one you already have'}
            </p>
            <p className="mt-1 text-muted">
              From{' '}
              <Link
                href={`/worksheets/${question.duplicateOf.worksheetId}`}
                className="underline underline-offset-2 hover:text-fg"
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
          href={`/worksheets/${worksheetId}/review?focus=${question.id}`}
          className="btn btn-secondary"
        >
          Something&rsquo;s wrong
        </Link>
        <button type="button" onClick={advance} className="btn btn-secondary">
          Skip
        </button>
      </div>

      <p className="hint">
        Press <kbd>Y</kbd> to accept, arrow keys to move. {remaining} left to check.
      </p>

      <button
        type="button"
        onClick={() => void acceptRemaining()}
        disabled={saving}
        className="text-sm text-muted underline underline-offset-2 hover:text-accent"
      >
        Accept the remaining {remaining} as they are
      </button>

      {/* Here rather than on the worksheet page: this is where a student is
          holding the paper next to what we read off it, and so the only place
          they can tell that whole questions are missing. */}
      <div className="border-t border-border pt-4">
        <ReportButton
          target={{ kind: 'worksheet', worksheetId }}
          label="Something is wrong with this whole worksheet"
          placeholder="Missing questions, wrong pages, numbering off?"
        />
      </div>
    </div>
  )
}
