'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import TopicPicker, { type TopicChoice } from '@/components/topic-picker'
import type { BBox, TextLine } from '@/lib/db/schema'

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
  promptText: string
  questionType: QuestionType
  bbox: BBox | null
  correctAnswer: string | null
  choices: { label: string; text: string; isCorrect: boolean }[]
  topicId: string | null
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

/** Ignore stray clicks; only a deliberate drag creates a question. */
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
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const page = pages[pageIndex]
  const selected = questions.find((question) => question.id === selectedId) ?? null
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

  /** Converts a pointer event into natural page-image pixel coordinates. */
  const toPageCoords = useCallback((event: React.PointerEvent): { x: number; y: number } => {
    const image = imageRef.current
    if (!image || !page) return { x: 0, y: 0 }

    const rect = image.getBoundingClientRect()
    const scaleX = page.width / rect.width
    const scaleY = page.height / rect.height

    return {
      x: Math.max(0, Math.min(page.width, (event.clientX - rect.left) * scaleX)),
      y: Math.max(0, Math.min(page.height, (event.clientY - rect.top) * scaleY)),
    }
  }, [page])

  const persist = useCallback(
    (question: EditableQuestion) => {
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
    },
    [],
  )

  const update = useCallback(
    (id: string, patch: Partial<EditableQuestion>) => {
      const current = questions.find((question) => question.id === id)
      if (!current) return

      // Built outside the updater so the save isn't fired twice under
      // StrictMode's double-invoked reducers.
      const next = { ...current, ...patch }
      setQuestions((list) => list.map((q) => (q.id === id ? next : q)))
      persist(next)
    },
    [questions, persist],
  )

  async function createQuestion(bbox: BBox | null) {
    if (!page) return
    setError(null)

    const promptText = bbox ? textInside(page.textLines, bbox) : ''
    const ordinal = questions.length + 1

    const body = {
      pageId: page.id,
      ordinal,
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
        { ...body, id: questionId, correctAnswer: null, topicId: null },
      ])
      setSelectedId(questionId)
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

    // Let any debounced saves land before the worksheet is locked in.
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
      <p className="rounded border border-border bg-surface px-4 py-6 text-sm text-muted">
        This worksheet has no pages. Upload it again.
      </p>
    )
  }

  const pctX = (v: number) => `${(v / page.width) * 100}%`
  const pctY = (v: number) => `${(v / page.height) * 100}%`

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_26rem]">
      {/* ---------------------------------------------------------------- */}
      <section aria-labelledby="page-heading" className="min-w-0">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id="page-heading" className="text-sm font-medium">
            <span className="text-muted">{worksheetTitle} — </span>
            Page <span className="tabular-nums">{page.pageNumber}</span> of{' '}
            <span className="tabular-nums">{pages.length}</span>
          </h2>

          <div className="flex gap-2">
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
              disabled={pageIndex === 0}
              onClick={() => setPageIndex((index) => index - 1)}
            >
              Previous
            </button>
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
              disabled={pageIndex >= pages.length - 1}
              onClick={() => setPageIndex((index) => index + 1)}
            >
              Next
            </button>
          </div>
        </div>

        <div
          className="relative touch-none select-none overflow-hidden rounded border border-border bg-surface"
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.currentTarget.setPointerCapture(event.pointerId)
            const point = toPageCoords(event)
            dragStart.current = point
            setDraft([point.x, point.y, point.x, point.y])
          }}
          onPointerMove={(event) => {
            if (!dragStart.current) return
            const point = toPageCoords(event)
            const start = dragStart.current
            setDraft([
              Math.min(start.x, point.x),
              Math.min(start.y, point.y),
              Math.max(start.x, point.x),
              Math.max(start.y, point.y),
            ])
          }}
          onPointerUp={() => {
            const box = draft
            dragStart.current = null
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
                aria-label={`Select question ${question.ordinal}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => setSelectedId(question.id)}
                style={{
                  left: pctX(question.bbox[0]),
                  top: pctY(question.bbox[1]),
                  width: pctX(question.bbox[2] - question.bbox[0]),
                  height: pctY(question.bbox[3] - question.bbox[1]),
                }}
                className={`absolute rounded-sm border-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                  question.id === selectedId
                    ? 'border-accent bg-accent/15'
                    : 'border-accent/50 bg-accent/5 hover:bg-accent/10'
                }`}
              >
                <span className="absolute -top-px left-0 -translate-y-full rounded-t bg-accent px-1 text-xs tabular-nums text-accent-fg">
                  {question.ordinal}
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

        <p className="hint">
          Drag on the page to add a question. Tap a box to edit it.
        </p>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section aria-labelledby="questions-heading" className="min-w-0 space-y-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="questions-heading" className="text-sm font-medium">
            <span className="tabular-nums">{questions.length}</span>{' '}
            {questions.length === 1 ? 'question' : 'questions'}
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
            className="rounded border border-danger/40 px-3 py-2 text-sm text-danger"
          >
            {error}
          </p>
        )}

        {questions.length === 0 && (
          <p className="rounded border border-dashed border-border px-3 py-6 text-center text-sm text-muted">
            No questions yet. Drag a box around the first one on the page.
          </p>
        )}

        {questions.length > 0 && (
          <ul className="max-h-48 divide-y divide-border overflow-y-auto overscroll-contain rounded border border-border">
            {questions.map((question) => (
              <li key={question.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(question.id)
                    const index = pages.findIndex((p) => p.id === question.pageId)
                    if (index >= 0) setPageIndex(index)
                  }}
                  className={`flex w-full items-baseline gap-2 px-3 py-2 text-left text-sm ${
                    question.id === selectedId ? 'bg-accent/10' : 'hover:bg-accent/5'
                  }`}
                >
                  <span className="shrink-0 tabular-nums text-muted">
                    {question.ordinal}.
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {question.promptText || 'Untitled question'}
                  </span>
                  {!question.topicId && (
                    <span className="shrink-0 text-xs text-muted">No topic</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => void createQuestion(null)}
        >
          Add Question Without a Box
        </button>

        {selected && (
          <div className="space-y-4 rounded border border-border bg-surface p-4">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-sm font-medium">
                Question <span className="tabular-nums">{selected.ordinal}</span>
              </h3>
              <button
                type="button"
                className="rounded px-1 text-sm text-muted underline underline-offset-2 hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                onClick={() => void removeQuestion(selected.id)}
              >
                Delete
              </button>
            </div>

            <div>
              <label className="label" htmlFor="prompt">
                Question text
              </label>
              <textarea
                id="prompt"
                rows={4}
                className="field resize-y"
                value={selected.promptText}
                onChange={(event) =>
                  update(selected.id, { promptText: event.target.value })
                }
              />
            </div>

            <div>
              <label className="label" htmlFor="qtype">
                Type
              </label>
              <select
                id="qtype"
                className="field bg-surface text-fg"
                value={selected.questionType}
                onChange={(event) =>
                  update(selected.id, {
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

            {selected.questionType === 'multiple_choice' && (
              <fieldset>
                <legend className="label">Answer choices</legend>

                <ul className="space-y-2">
                  {selected.choices.map((choice, index) => (
                    <li key={index} className="flex items-center gap-2">
                      <input
                        type="radio"
                        name={`correct-${selected.id}`}
                        checked={choice.isCorrect}
                        aria-label={`Mark choice ${choice.label} correct`}
                        className="size-4 shrink-0 accent-[var(--accent)]"
                        onChange={() =>
                          update(selected.id, {
                            choices: selected.choices.map((other, i) => ({
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
                          update(selected.id, {
                            choices: selected.choices.map((other, i) =>
                              i === index ? { ...other, text: event.target.value } : other,
                            ),
                          })
                        }
                      />
                      <button
                        type="button"
                        aria-label={`Remove choice ${choice.label}`}
                        className="shrink-0 rounded px-1 text-sm text-muted hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        onClick={() =>
                          update(selected.id, {
                            choices: selected.choices
                              .filter((_, i) => i !== index)
                              .map((other, i) => ({ ...other, label: CHOICE_LABELS[i] })),
                          })
                        }
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>

                {selected.choices.length < CHOICE_LABELS.length && (
                  <button
                    type="button"
                    className="mt-2 rounded border border-border px-2 py-1 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    onClick={() =>
                      update(selected.id, {
                        choices: [
                          ...selected.choices,
                          {
                            label: CHOICE_LABELS[selected.choices.length],
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

            {selected.questionType !== 'multiple_choice' && (
              <div>
                <label className="label" htmlFor="answer">
                  Correct answer{' '}
                  <span className="font-normal text-muted">(optional)</span>
                </label>
                <input
                  id="answer"
                  type="text"
                  autoComplete="off"
                  className="field"
                  value={selected.correctAnswer ?? ''}
                  onChange={(event) =>
                    update(selected.id, { correctAnswer: event.target.value || null })
                  }
                />
              </div>
            )}

            <TopicPicker
              topics={topics}
              value={selected.topicId}
              onChange={(topicId) => update(selected.id, { topicId })}
            />
          </div>
        )}

        <button
          type="button"
          className="btn btn-primary"
          disabled={questions.length === 0 || confirming}
          onClick={() => void confirm()}
        >
          {confirming
            ? 'Confirming…'
            : `Confirm ${questions.length} ${questions.length === 1 ? 'Question' : 'Questions'}`}
        </button>
      </section>
    </div>
  )
}
