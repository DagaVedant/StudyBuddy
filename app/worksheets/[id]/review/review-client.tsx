'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import TopicPicker, { type TopicChoice } from '@/components/topic-picker'
import type { BBox, TextLine } from '@/lib/db/schema'
import { choiceLabel } from '@/lib/questions/shape'

export interface EditablePage {
  id: string
  pageNumber: number
  imageSrc: string
  width: number
  height: number
  textLines: TextLine[]
}

type QuestionType =
  | 'multiple_choice'
  | 'free_response'
  | 'true_false'
  | 'fill_blank'
  | 'grid_in'

export interface EditableQuestion {
  id: string
  pageId: string | null
  ordinal: number
  /** The number printed on the paper. Null when the sheet numbers nothing. */
  printedNumber: number | null
  promptText: string
  questionType: QuestionType
  bbox: BBox | null
  correctAnswer: string | null
  choices: { label: string; text: string; isCorrect: boolean }[]
  topicId: string | null
}

/**
 * What to show beside a question.
 *
 * The number printed on the paper, so the label matches what the student is
 * looking at. Ordinal is a row counter and only ever coincided with the paper
 * by luck; it once put "138" beside question 25 of 114. It stays as the
 * fallback for worksheets that print no numbers at all, where a position is
 * better than nothing.
 */
function questionLabel(question: EditableQuestion): number {
  return question.printedNumber ?? question.ordinal
}

interface Props {
  worksheetId: string
  worksheetTitle: string
  pages: EditablePage[]
  initialQuestions: EditableQuestion[]
  topics: TopicChoice[]
}

const QUESTION_TYPES: { value: QuestionType; label: string }[] = [
  { value: 'multiple_choice', label: 'Multiple Choice' },
  { value: 'free_response', label: 'Free Response' },
  { value: 'true_false', label: 'True or False' },
  { value: 'fill_blank', label: 'Fill in the Blank' },
  { value: 'grid_in', label: 'Grid-In' },
]

const CHOICE_LABELS = ['A', 'B', 'C', 'D', 'E', 'F']
const MIN_DRAG_PX = 12

function textInside(lines: TextLine[], box: BBox): string {
  const [bx0, by0, bx1, by1] = box

  return lines
    .filter((line) => {
      const [x0, y0, x1, y1] = line.bbox
      const cx = (x0 + x1) / 2
      const cy = (y0 + y1) / 2
      return cx >= bx0 && cx <= bx1 && cy >= by0 && cy <= by1
    })
    .sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0])
    .map((line) => line.text)
    .join('\n')
    .trim()
}

export default function ReviewClient({
  worksheetId,
  worksheetTitle,
  pages,
  initialQuestions,
  topics,
}: Props) {
  const router = useRouter()

  const [questions, setQuestions] = useState(initialQuestions)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(
    initialQuestions[0]?.id ?? null,
  )
  const [pageIndex, setPageIndex] = useState(0)
  const [draft, setDraft] = useState<BBox | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const imageRef = useRef<HTMLImageElement>(null)
  const dragStart = useRef<{ x: number; y: number } | null>(null)
  const draftRef = useRef<BBox | null>(null)
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const cardRefs = useRef(new Map<string, HTMLLIElement>())

  const page = pages[pageIndex]
  const topicById = useMemo(
    () => new Map(topics.map((topic) => [topic.id, topic])),
    [topics],
  )

  const pageQuestions = useMemo(
    () => questions.filter((question) => question.pageId === page?.id),
    [questions, page?.id],
  )

  useEffect(() => {
    const timers = saveTimers.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
    }
  }, [])

  const toPageCoords = useCallback(
    (event: React.PointerEvent): { x: number; y: number } => {
      const image = imageRef.current
      if (!image || !page) return { x: 0, y: 0 }

      const rect = image.getBoundingClientRect()
      return {
        x: Math.max(0, Math.min(page.width, (event.clientX - rect.left) * (page.width / rect.width))),
        y: Math.max(0, Math.min(page.height, (event.clientY - rect.top) * (page.height / rect.height))),
      }
    },
    [page],
  )

  const persist = useCallback((question: EditableQuestion) => {
    const timers = saveTimers.current
    clearTimeout(timers.get(question.id))

    timers.set(
      question.id,
      setTimeout(async () => {
        setSaveState('saving')
        try {
          const response = await fetch(`/api/questions/${question.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              promptText: question.promptText,
              questionType: question.questionType,
              bbox: question.bbox,
              correctAnswer: question.correctAnswer,
              choices: question.choices,
              topicId: question.topicId,
            }),
          })
          if (!response.ok) throw new Error('Save failed')
          setSaveState('saved')
        } catch {
          setSaveState('error')
          setError('Could not save that change. Check your connection and try again.')
        }
      }, 600),
    )
  }, [])

  const update = useCallback(
    (id: string, patch: Partial<EditableQuestion>) => {
      const current = questions.find((question) => question.id === id)
      if (!current) return

      const next = { ...current, ...patch }
      setQuestions((list) => list.map((q) => (q.id === id ? next : q)))
      persist(next)
    },
    [questions, persist],
  )

  function focusQuestion(id: string) {
    setSelectedId(id)
    const question = questions.find((q) => q.id === id)
    const index = pages.findIndex((p) => p.id === question?.pageId)
    if (index >= 0) setPageIndex(index)
    cardRefs.current.get(id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

  async function createQuestion(bbox: BBox | null) {
    if (!page) return
    setError(null)

    const promptText = bbox ? textInside(page.textLines, bbox) : ''
    const body = {
      pageId: page.id,
      ordinal: questions.length + 1,
      promptText: promptText || 'New question',
      questionType: 'multiple_choice' as QuestionType,
      bbox,
      choices: [],
    }

    try {
      const response = await fetch(`/api/worksheets/${worksheetId}/questions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error('Create failed')

      const { questionId } = (await response.json()) as { questionId: string }
      setQuestions((current) => [
        ...current,
        // Null rather than a made-up number: a question added by hand has no
        // number printed on the paper, so it falls back to its position.
        { ...body, id: questionId, correctAnswer: null, topicId: null, printedNumber: null },
      ])
      setSelectedId(questionId)
      setExpandedId(questionId)
      setSaveState('saved')
    } catch {
      setError('Could not add that question. Try again.')
    }
  }

  async function removeQuestion(id: string) {
    setQuestions((current) => current.filter((question) => question.id !== id))
    if (selectedId === id) setSelectedId(null)
    await fetch(`/api/questions/${id}`, { method: 'DELETE' }).catch(() => {})
  }

  async function confirm() {
    setConfirming(true)
    setError(null)
    // Let debounced saves land before the worksheet is locked in.
    await new Promise((resolve) => setTimeout(resolve, 700))

    try {
      const response = await fetch(`/api/worksheets/${worksheetId}/confirm`, {
        method: 'POST',
      })
      const body = (await response.json()) as { next?: string; error?: string }
      if (!response.ok) throw new Error(body.error ?? 'Could not confirm')
      router.push(body.next ?? '/dashboard')
    } catch (cause) {
      setConfirming(false)
      setError(cause instanceof Error ? cause.message : 'Could not confirm.')
    }
  }

  if (!page) {
    return (
      <p className="card px-4 py-6 text-sm text-muted">
        This worksheet has no pages. Upload it again.
      </p>
    )
  }

  const pctX = (v: number) => `${(v / page.width) * 100}%`
  const pctY = (v: number) => `${(v / page.height) * 100}%`
  const untagged = questions.filter((question) => !question.topicId).length

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_28rem]">
      {/* ---- Page image, with what was found drawn on it ---------------- */}
      <section aria-labelledby="page-heading" className="min-w-0">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id="page-heading" className="truncate text-sm font-medium">
            <span className="text-muted">{worksheetTitle} · </span>
            Page <span className="tabular-nums">{page.pageNumber}</span> of{' '}
            <span className="tabular-nums">{pages.length}</span>
          </h2>

          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              className="rounded-xl border border-border px-2 py-1 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
              disabled={pageIndex === 0}
              onClick={() => setPageIndex((index) => index - 1)}
            >
              Previous
            </button>
            <button
              type="button"
              className="rounded-xl border border-border px-2 py-1 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
              disabled={pageIndex >= pages.length - 1}
              onClick={() => setPageIndex((index) => index + 1)}
            >
              Next
            </button>
          </div>
        </div>

        <div
          className="card relative touch-none select-none overflow-hidden lg:sticky lg:top-4"
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.currentTarget.setPointerCapture(event.pointerId)
            const point = toPageCoords(event)
            dragStart.current = point
            const box: BBox = [point.x, point.y, point.x, point.y]
            draftRef.current = box
            setDraft(box)
          }}
          onPointerMove={(event) => {
            if (!dragStart.current) return
            const point = toPageCoords(event)
            const start = dragStart.current
            const box: BBox = [
              Math.min(start.x, point.x),
              Math.min(start.y, point.y),
              Math.max(start.x, point.x),
              Math.max(start.y, point.y),
            ]
            draftRef.current = box
            setDraft(box)
          }}
          onPointerUp={() => {
            // Reads the ref, not the `draft` state closure: a pointerup that
            // arrives before React commits the last pointermove's setDraft
            // would otherwise see a stale (often zero-size) box.
            const box = draftRef.current
            dragStart.current = null
            draftRef.current = null
            setDraft(null)
            if (!box) return
            if (box[2] - box[0] < MIN_DRAG_PX || box[3] - box[1] < MIN_DRAG_PX) return
            void createQuestion(box)
          }}
        >
          {/* Authenticated dynamic route; next/image can't forward the session. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imageRef}
            src={page.imageSrc}
            alt={`Page ${page.pageNumber} of ${worksheetTitle}`}
            width={page.width}
            height={page.height}
            className="block h-auto w-full"
          />

          {pageQuestions.map((question) =>
            question.bbox ? (
              <button
                key={question.id}
                type="button"
                aria-label={`Question ${questionLabel(question)}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => focusQuestion(question.id)}
                style={{
                  left: pctX(question.bbox[0]),
                  top: pctY(question.bbox[1]),
                  width: pctX(question.bbox[2] - question.bbox[0]),
                  height: pctY(question.bbox[3] - question.bbox[1]),
                }}
                className={`absolute rounded-sm border-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                  question.id === selectedId
                    ? 'border-accent bg-accent/15'
                    : 'border-accent/40 hover:bg-accent/10'
                }`}
              >
                <span className="absolute -top-px left-0 -translate-y-full rounded-t bg-accent px-1 text-xs tabular-nums text-accent-fg">
                  {questionLabel(question)}
                </span>
              </button>
            ) : null,
          )}

          {draft && (
            <div
              aria-hidden="true"
              style={{
                left: pctX(draft[0]),
                top: pctY(draft[1]),
                width: pctX(draft[2] - draft[0]),
                height: pctY(draft[3] - draft[1]),
              }}
              className="absolute rounded-sm border-2 border-dashed border-accent bg-accent/10"
            />
          )}
        </div>

        <p className="hint">Missed one? Drag a box around it on the page.</p>
      </section>

      {/* ---- Extracted question cards ---------------------------------- */}
      <section aria-labelledby="questions-heading" className="min-w-0 space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="questions-heading" className="text-sm font-medium">
            <span className="tabular-nums">{questions.length}</span>{' '}
            {questions.length === 1 ? 'question found' : 'questions found'}
          </h2>
          <span aria-live="polite" className="text-sm text-muted">
            {saveState === 'saving' && 'Saving…'}
            {saveState === 'saved' && 'Saved'}
            {saveState === 'error' && 'Not saved'}
          </span>
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-xl border border-danger/40 px-3 py-2 text-sm text-danger"
          >
            {error}
          </p>
        )}

        {questions.length === 0 && (
          <p className="rounded-2xl border border-dashed border-border px-3 py-8 text-center text-sm text-muted">
            Nothing was picked up from this page. Drag a box around a question to
            add it by hand.
          </p>
        )}

        <ul className="space-y-3">
          {questions.map((question) => {
            const expanded = expandedId === question.id
            const topic = question.topicId ? topicById.get(question.topicId) : null
            const correct = question.choices.find((choice) => choice.isCorrect)

            return (
              <li
                key={question.id}
                ref={(node) => {
                  if (node) cardRefs.current.set(question.id, node)
                  else cardRefs.current.delete(question.id)
                }}
                className={`rounded-2xl border bg-surface shadow-[0_8px_20px_-14px_oklch(0%_0_0_/_0.35)] ${
                  question.id === selectedId ? 'border-accent' : 'border-transparent'
                }`}
              >
                {/* Summary — what the AI actually pulled off the page. */}
                <div className="p-3">
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-xs font-medium tabular-nums text-accent">
                      {questionLabel(question)}
                    </span>
                    <button
                      type="button"
                      onClick={() => focusQuestion(question.id)}
                      className="min-w-0 flex-1 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      <span className="line-clamp-3 whitespace-pre-line">
                        {question.promptText || 'Untitled question'}
                      </span>
                    </button>
                  </div>

                  {question.choices.length > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-1.5 pl-8">
                      {question.choices.map((choice, index) => (
                        <li
                          key={index}
                          className={`rounded-full border px-2 py-0.5 text-xs ${
                            choice.isCorrect
                              ? 'border-success text-success'
                              : 'border-border text-muted'
                          }`}
                        >
                          <span className="font-medium">
                            {choiceLabel(choice.label)}.
                          </span>{' '}
                          <span className="max-w-32 truncate align-bottom">
                            {choice.text || 'blank'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 pl-8 text-xs">
                    {topic ? (
                      <span className="truncate text-muted" title={topic.path}>
                        {topic.name}
                      </span>
                    ) : (
                      <span className="text-warning">No topic</span>
                    )}
                    {!correct && question.questionType === 'multiple_choice' && (
                      <span className="text-muted">No answer key</span>
                    )}
                    <button
                      type="button"
                      className="ml-auto shrink-0 text-accent underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      aria-expanded={expanded}
                      onClick={() => {
                        setExpandedId(expanded ? null : question.id)
                        focusQuestion(question.id)
                      }}
                    >
                      {expanded ? 'Done' : 'Fix'}
                    </button>
                  </div>
                </div>

                {/* Editor — only when something needs correcting. */}
                {expanded && (
                  <div className="space-y-4 border-t border-border p-3">
                    <div>
                      <label className="label" htmlFor={`prompt-${question.id}`}>
                        Question text
                      </label>
                      <textarea
                        id={`prompt-${question.id}`}
                        rows={4}
                        className="field resize-y"
                        value={question.promptText}
                        onChange={(event) =>
                          update(question.id, { promptText: event.target.value })
                        }
                      />
                    </div>

                    <div>
                      <label className="label" htmlFor={`type-${question.id}`}>
                        Type
                      </label>
                      <select
                        id={`type-${question.id}`}
                        className="field bg-surface text-fg"
                        value={question.questionType}
                        onChange={(event) =>
                          update(question.id, {
                            questionType: event.target.value as QuestionType,
                          })
                        }
                      >
                        {QUESTION_TYPES.map((type) => (
                          <option key={type.value} value={type.value}>
                            {type.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    {question.questionType === 'multiple_choice' && (
                      <fieldset>
                        <legend className="label">Answer choices</legend>
                        <ul className="space-y-2">
                          {question.choices.map((choice, index) => (
                            <li key={index} className="flex items-center gap-2">
                              <input
                                type="radio"
                                name={`correct-${question.id}`}
                                checked={choice.isCorrect}
                                aria-label={`Mark choice ${choice.label} correct`}
                                className="size-4 shrink-0 accent-[var(--accent)]"
                                onChange={() =>
                                  update(question.id, {
                                    choices: question.choices.map((other, i) => ({
                                      ...other,
                                      isCorrect: i === index,
                                    })),
                                    correctAnswer: choice.label,
                                  })
                                }
                              />
                              <span className="w-5 shrink-0 text-sm text-muted">
                                {choice.label}
                              </span>
                              <input
                                type="text"
                                aria-label={`Text for choice ${choice.label}`}
                                className="field min-w-0 flex-1"
                                value={choice.text}
                                onChange={(event) =>
                                  update(question.id, {
                                    choices: question.choices.map((other, i) =>
                                      i === index
                                        ? { ...other, text: event.target.value }
                                        : other,
                                    ),
                                  })
                                }
                              />
                              <button
                                type="button"
                                aria-label={`Remove choice ${choice.label}`}
                                className="shrink-0 rounded px-1 text-sm text-muted hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                                onClick={() =>
                                  update(question.id, {
                                    choices: question.choices
                                      .filter((_, i) => i !== index)
                                      .map((other, i) => ({
                                        ...other,
                                        label: CHOICE_LABELS[i],
                                      })),
                                  })
                                }
                              >
                                Remove
                              </button>
                            </li>
                          ))}
                        </ul>

                        {question.choices.length < CHOICE_LABELS.length && (
                          <button
                            type="button"
                            className="mt-2 rounded-xl border border-border px-2 py-1 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                            onClick={() =>
                              update(question.id, {
                                choices: [
                                  ...question.choices,
                                  {
                                    label: CHOICE_LABELS[question.choices.length],
                                    text: '',
                                    isCorrect: false,
                                  },
                                ],
                              })
                            }
                          >
                            Add Choice
                          </button>
                        )}
                      </fieldset>
                    )}

                    {question.questionType !== 'multiple_choice' && (
                      <div>
                        <label className="label" htmlFor={`answer-${question.id}`}>
                          Correct answer{' '}
                          <span className="font-normal text-muted">(optional)</span>
                        </label>
                        <input
                          id={`answer-${question.id}`}
                          type="text"
                          autoComplete="off"
                          className="field"
                          value={question.correctAnswer ?? ''}
                          onChange={(event) =>
                            update(question.id, {
                              correctAnswer: event.target.value || null,
                            })
                          }
                        />
                      </div>
                    )}

                    <TopicPicker
                      topics={topics}
                      value={question.topicId}
                      onChange={(topicId) => update(question.id, { topicId })}
                    />

                    <button
                      type="button"
                      className="rounded px-1 text-sm text-muted underline underline-offset-2 hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      onClick={() => void removeQuestion(question.id)}
                    >
                      Delete this question
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>

        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => void createQuestion(null)}
        >
          Add a Question by Hand
        </button>

        <div className="sticky bottom-0 -mx-1 border-t border-border bg-bg px-1 pb-1 pt-3">
          {untagged > 0 && (
            <p className="hint mb-2">
              <span className="tabular-nums">{untagged}</span> still have no topic.
              They will show up on the dashboard under a broader heading.
            </p>
          )}
          <button
            type="button"
            className="btn btn-primary touch-manipulation"
            disabled={questions.length === 0 || confirming}
            onClick={() => void confirm()}
          >
            {confirming
              ? 'Confirming…'
              : `Looks Right, Mark ${questions.length} ${
                  questions.length === 1 ? 'Question' : 'Questions'
                }`}
          </button>
        </div>
      </section>
    </div>
  )
}
