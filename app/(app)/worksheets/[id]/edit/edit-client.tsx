'use client'

import {
  defaultRangeExtractor,
  type Range,
  useWindowVirtualizer,
} from '@tanstack/react-virtual'
import {
  type CSSProperties,
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {useRouter} from 'next/navigation'

import {TopicPicker, type TopicChoice} from '@/components/client'
import {choiceLabel} from '@/lib/questions/shape'
import {fetchJson} from '@/lib/client/http'
import {reflowText} from '@/lib/questions/shape'
import {type BBox, type TextLine} from '@/lib/schema'
export interface EditablePage {
  id: string
  pageNumber: number
  imageSrc: string
  width: number
  height: number
  textLines: TextLine[]
}

export type QuestionType =
  | 'multiple_choice'
  | 'free_response'
  | 'true_false'
  | 'fill_blank'
  | 'grid_in'

export interface EditableQuestion {
  id: string
  pageId: string | null
  ordinal: number
  printedNumber: number | null
  promptText: string
  questionType: QuestionType
  bbox: BBox | null
  correctAnswer: string | null
  choices: {id: string; label: string; text: string; isCorrect: boolean}[]
  topicId: string | null
}

export const QUESTION_TYPES: {value: QuestionType; label: string}[] = [
  {value: 'multiple_choice', label: 'Multiple Choice'},
  {value: 'free_response', label: 'Free Response'},
  {value: 'true_false', label: 'True or False'},
  {value: 'fill_blank', label: 'Fill in the Blank'}, {value: 'grid_in', label: 'Grid-In'},
]

export const CHOICE_LABELS = ['A', 'B', 'C', 'D', 'E', 'F']

export function questionLabel(question: EditableQuestion): number {
  return question.printedNumber ?? question.ordinal
}

export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export interface QuestionEditor {
  questions: EditableQuestion[]
  saveState: SaveState
  error: string | null
  confirming: boolean
  update: (id: string, patch: Partial<EditableQuestion>) => void
  createQuestion: (
    pageId: string,
    bbox: BBox | null,
    promptText: string,
  ) => Promise<string | null>
  removeQuestion: (id: string) => Promise<void>
  restoreQuestion: (id: string) => boolean
  confirm: () => Promise<void>
  setError: (message: string | null) => void
}

const SAVE_DEBOUNCE_MS = 600

export const UNDO_WINDOW_MS = 8000

const SAVE_FAILED = 'Could not save that change. Check your connection and try again.'

function patchBody(question: EditableQuestion) {
  return {
    promptText: question.promptText,
    questionType: question.questionType,
    bbox: question.bbox,
    correctAnswer: question.correctAnswer,
    choices: question.choices,
    topicId: question.topicId,
  }
}

function carriedAnswer(
  previous: string | null,
  before: EditableQuestion['choices'],
  after: EditableQuestion['choices'],
): string | null {
  if (previous === null) return null

  const relabelled =
    before.length !== after.length ||
    before.some((choice, index) => choice.label !== after[index].label)
  if (!relabelled) return previous

  if (!before.some((choice) => choice.label === previous)) return previous

  let index = 0
  for (const choice of after) {
    while (index < before.length && before[index].text !== choice.text) index += 1
    if (index >= before.length) break
    if (before[index].label === previous) return choice.label
    index += 1
  }

  return null
}

export function useQuestionEditor(
  worksheetId: string,
  initialQuestions: EditableQuestion[],
): QuestionEditor {
  const router = useRouter()

  const [questions, setQuestions] = useState(initialQuestions)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const questionsRef = useRef(initialQuestions)

  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const owed = useRef(new Map<string, EditableQuestion>())
  const inFlight = useRef(0)

  const pendingRemovals = useRef(
    new Map<
      string,
      {question: EditableQuestion; index: number; timer: ReturnType<typeof setTimeout>}
    >(),
  )

  const settle = useCallback(() => {
    if (
      owed.current.size > 0 ||
      inFlight.current !== 0 ||
      pendingRemovals.current.size > 0
    ) {
      return
    }

    setSaveState('saved')

    setError((current) => (current === SAVE_FAILED ? null : current))
  }, [])

  const send = useCallback(
    async (question: EditableQuestion, keepalive = false) => {
      clearTimeout(saveTimers.current.get(question.id))
      saveTimers.current.delete(question.id)

      inFlight.current += 1
      setSaveState('saving')

      try {
        const response = await fetchJson(`/api/questions/${question.id}`, {
          method: 'PATCH',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(patchBody(question)),
          keepalive,
        })
        if (!response.ok) throw new Error('Save failed')

        if (owed.current.get(question.id) === question) owed.current.delete(question.id)

        inFlight.current -= 1
        settle()
      } catch {
        inFlight.current -= 1
        setSaveState('error')
        setError(SAVE_FAILED)
      }
    },
    [settle],
  )

  const persist = useCallback(
    (question: EditableQuestion) => {
      owed.current.set(question.id, question)
      setSaveState('saving')

      clearTimeout(saveTimers.current.get(question.id))
      saveTimers.current.set(
        question.id,
        setTimeout(() => void send(question), SAVE_DEBOUNCE_MS),
      )
    },
    [send],
  )

  const commitRemoval = useCallback(async (id: string) => {
    const pending = pendingRemovals.current.get(id)
    if (!pending) return

    clearTimeout(pending.timer)

    try {
      const response = await fetchJson(`/api/questions/${id}`, {
        method: 'DELETE',
        keepalive: true,
      })

      if (!response.ok && response.status !== 404) {
        throw new Error(`Delete failed (${response.status})`)
      }

      pendingRemovals.current.delete(id)
      settle()
    } catch {
      setError(SAVE_FAILED)
      setSaveState('error')
    }
  }, [settle])

  const flush = useCallback(async () => {
    await Promise.all([
      ...[...pendingRemovals.current.keys()].map((id) => commitRemoval(id)),
      ...[...owed.current.values()].map((question) => send(question)),
    ])
  }, [send, commitRemoval])

  useEffect(() => {
    const timers = saveTimers.current
    const debts = owed.current
    const removals = pendingRemovals.current

    const flushBeyondThePage = () => {
      for (const question of debts.values()) void send(question, true)
      for (const id of [...removals.keys()]) void commitRemoval(id)
    }

    const onPageHide = () => flushBeyondThePage()
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushBeyondThePage()
    }

    window.addEventListener('pagehide', onPageHide)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      window.removeEventListener('pagehide', onPageHide)
      document.removeEventListener('visibilitychange', onVisibilityChange)

      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()

      flushBeyondThePage()
    }
  }, [send, commitRemoval])

  const update = useCallback(
    (id: string, patch: Partial<EditableQuestion>) => {
      const current = questionsRef.current.find((question) => question.id === id)
      if (!current) return

      const next = {...current, ...patch}

      if (patch.choices !== undefined && patch.correctAnswer === undefined) {
        next.correctAnswer = carriedAnswer(
          current.correctAnswer,
          current.choices,
          patch.choices,
        )
      }

      questionsRef.current = questionsRef.current.map((question) =>
        question.id === id ? next : question,
      )

      setQuestions(questionsRef.current)
      persist(next)
    },
    [persist],
  )

  const reservedOrdinal = useRef(0)

  const reserveOrdinal = useCallback(() => {
    const highest = questionsRef.current.reduce(
      (top, question) => Math.max(top, question.ordinal),
      0,
    )

    reservedOrdinal.current = Math.max(highest, reservedOrdinal.current) + 1
    return reservedOrdinal.current
  }, [])

  const createQuestion = useCallback(
    async (pageId: string, bbox: BBox | null, promptText: string) => {
      setError(null)

      const body = {
        pageId,
        ordinal: reserveOrdinal(),
        promptText: promptText || 'New question',
        questionType: 'multiple_choice' as QuestionType,
        bbox,
        choices: [],
      }

      try {
        const response = await fetchJson(`/api/worksheets/${worksheetId}/questions`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(body),
        })
        if (!response.ok) throw new Error('Create failed')

        const {questionId} = (await response.json()) as {questionId: string}

        questionsRef.current = [
          ...questionsRef.current,
          {...body, id: questionId, correctAnswer: null, topicId: null, printedNumber: null},
        ]
        setQuestions(questionsRef.current)
        settle()
        return questionId
      } catch {
        setError('Could not add that question. Try again.')
        return null
      }
    },
    [worksheetId, settle, reserveOrdinal],
  )

  const removeQuestion = useCallback(
    async (id: string) => {
      clearTimeout(saveTimers.current.get(id))
      saveTimers.current.delete(id)
      owed.current.delete(id)

      const index = questionsRef.current.findIndex((question) => question.id === id)
      if (index < 0) return

      const question = questionsRef.current[index]
      questionsRef.current = questionsRef.current.filter((other) => other.id !== id)
      setQuestions(questionsRef.current)

      pendingRemovals.current.set(id, {
        question,
        index,
        timer: setTimeout(() => void commitRemoval(id), UNDO_WINDOW_MS),
      })

      settle()
    },
    [commitRemoval, settle],
  )

  const restoreQuestion = useCallback((id: string) => {
    const pending = pendingRemovals.current.get(id)
    if (!pending) return false

    clearTimeout(pending.timer)
    pendingRemovals.current.delete(id)

    const next = [...questionsRef.current]
    next.splice(pending.index, 0, pending.question)
    questionsRef.current = next
    setQuestions(next)

    return true
  }, [])

  const confirm = useCallback(async () => {
    setConfirming(true)
    setError(null)

    await flush()

    try {
      const response = await fetchJson(`/api/worksheets/${worksheetId}/confirm`, {
        method: 'POST',
      })
      const body = (await response.json()) as {next?: string; error?: string}
      if (!response.ok) throw new Error(body.error ?? 'Could not confirm')
      router.push(body.next ?? '/dashboard')
    } catch (cause) {
      setConfirming(false)
      setError(cause instanceof Error ? cause.message : 'Could not confirm.')
    }
  }, [worksheetId, router, flush])

  return {
    questions,
    saveState,
    error,
    confirming,
    update,
    createQuestion,
    removeQuestion,
    restoreQuestion,
    confirm,
    setError,
  }
}

const MIN_DRAG_PX = 12

export function textInside(lines: TextLine[], box: BBox): string {
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

export function PageCanvas({
  page,
  linesReady,
  pageNumber,
  pageCount,
  worksheetTitle,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onSelect,
}: {
  page: EditablePage
  linesReady: boolean
  pageNumber: number
  pageCount: number
  worksheetTitle: string
  canGoBack: boolean
  canGoForward: boolean
  onBack: () => void
  onForward: () => void
  onSelect: (bbox: BBox, promptText: string) => void
}) {
  const [draft, setDraft] = useState<BBox | null>(null)
  const [drawing, setDrawing] = useState(false)

  const imageRef = useRef<HTMLImageElement>(null)
  const dragStart = useRef<{x: number; y: number} | null>(null)
  const draftRef = useRef<BBox | null>(null)

  const endDrag = useCallback(() => {
    dragStart.current = null
    draftRef.current = null
    setDraft(null)
  }, [])

  const toPageCoords = useCallback(
    (event: React.PointerEvent): {x: number; y: number} => {
      const image = imageRef.current
      if (!image) return {x: 0, y: 0}

      const rect = image.getBoundingClientRect()
      return {
        x: Math.max(
          0,
          Math.min(page.width, (event.clientX - rect.left) * (page.width / rect.width)),
        ),
        y: Math.max(
          0,
          Math.min(page.height, (event.clientY - rect.top) * (page.height / rect.height)),
        ),
      }
    },
    [page.width, page.height],
  )

  const pctX = (v: number) => `${(v / page.width) * 100}%`
  const pctY = (v: number) => `${(v / page.height) * 100}%`

  return (
    <section aria-labelledby="page-heading" className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="page-heading" className="truncate text-sm font-medium">
          <span className="text-muted">{worksheetTitle} · </span>
          Page <span className="tabular-nums">{pageNumber}</span> of{' '}
          <span className="tabular-nums">{pageCount}</span>
        </h2>

        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            className="min-h-11 rounded-xl px-3 py-1 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
            disabled={!canGoBack}
            onClick={onBack}
          >
            Previous
          </button>
          <button
            type="button"
            className="min-h-11 rounded-xl px-3 py-1 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
            disabled={!canGoForward}
            onClick={onForward}
          >
            Next
          </button>
        </div>
      </div>

      <div
        className={`card relative select-none overflow-hidden ${
          drawing ? 'touch-none ring-2 ring-accent' : 'touch-manipulation'
        }`}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          if (event.pointerType !== 'mouse' && !drawing) return
          if (!linesReady) return
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
            Math.min(start.x, point.x), Math.min(start.y, point.y),
            Math.max(start.x, point.x), Math.max(start.y, point.y),
          ]
          draftRef.current = box
          setDraft(box)
        }}
        onPointerUp={() => {
          const box = draftRef.current
          endDrag()
          if (!box) return
          if (box[2] - box[0] < MIN_DRAG_PX || box[3] - box[1] < MIN_DRAG_PX) return

          setDrawing(false)
          onSelect(box, textInside(page.textLines, box))
        }}
        onPointerCancel={endDrag}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imageRef}
          src={page.imageSrc}
          alt={`Page ${page.pageNumber} of ${worksheetTitle}`}
          width={page.width}
          height={page.height}
          draggable={false}
          className="block h-auto w-full [-webkit-user-drag:none]"
        />

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

      <p className="hint any-pointer-coarse:hidden" role={linesReady ? undefined : 'status'}>
        {linesReady
          ? 'Missed one? Drag a box around it on the page.'
          : 'Loading this page’s text…'}
      </p>

      <div className="inset-safe-bottom mt-1.5 hidden items-center gap-2 any-pointer-coarse:flex">
        <button
          type="button"
          aria-pressed={drawing}
          disabled={!linesReady}
          className="shrink-0 rounded-xl bg-surface px-3 py-1.5 text-sm shadow-[0_8px_20px_-14px_oklch(0%_0_0_/_0.35)] hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
          onClick={() => {
            setDrawing((on) => !on)
            endDrag()
          }}
        >
          {drawing ? 'Cancel' : 'Draw a Box'}
        </button>
        <span className="text-sm text-muted">
          {!linesReady
            ? 'Loading this page’s text…'
            : drawing
              ? 'Drag around the question you want to add.'
              : 'Missed one? Draw a box around it.'}
        </span>
      </div>
    </section>
  )
}
let choiceKeySeq = 0
const nextChoiceKey = () => `new-choice-${(choiceKeySeq += 1)}`

interface CardProps {
  question: EditableQuestion
  expanded: boolean
  selected: boolean
  topic: TopicChoice | null
  topics: TopicChoice[]
  onUpdate: (id: string, patch: Partial<EditableQuestion>) => void
  onRemove: (id: string) => void
  onFocus: (id: string, pageId: string | null) => void
  onToggleExpanded: (id: string, pageId: string | null) => void
  registerRef: (id: string, node: HTMLLIElement | null) => void
  measureRef?: (node: HTMLLIElement | null) => void
  style?: CSSProperties
  dataIndex?: number
}

const QuestionCard = memo(function QuestionCard({
  question,
  expanded,
  selected,
  topic,
  topics,
  onUpdate,
  onRemove,
  onFocus,
  onToggleExpanded,
  registerRef,
  measureRef,
  style,
  dataIndex,
}: CardProps) {
  const correct = question.choices.find((choice) => choice.isCorrect)

  return (
    <li
      ref={(node) => {
        registerRef(question.id, node)
        measureRef?.(node)
      }}
      style={style}
      data-index={dataIndex}
      className={`rounded-2xl border bg-surface shadow-[0_8px_20px_-14px_oklch(0%_0_0_/_0.35)] ${
          selected ? 'bg-accent/10' : ''
      }`}
    >
      <div className="p-3">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-xs font-medium tabular-nums text-accent">
            {questionLabel(question)}
          </span>
          <button
            type="button"
            onClick={() => onFocus(question.id, question.pageId)}
            className="min-w-0 flex-1 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <span className="line-clamp-3 whitespace-pre-line">
              {reflowText(question.promptText) || 'Untitled question'}
            </span>
          </button>
        </div>

        {question.choices.length > 0 && (
          <ul className="mt-2 space-y-0.5 pl-8 text-xs">
            {question.choices.map((choice) => (
              <li
                key={choice.id}
                className={`flex gap-1.5 ${
              choice.isCorrect ? 'text-success' : 'text-muted'
                }`}
              >
                <span className="shrink-0 font-medium">{choiceLabel(choice.label)}.</span>
                <span className="line-clamp-2 min-w-0 flex-1 break-words">
                  {choice.text || 'blank'}
                </span>
                {choice.isCorrect && <span className="sr-only">correct answer</span>}
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
            onClick={() => onToggleExpanded(question.id, question.pageId)}
          >
            {expanded ? 'Done' : 'Fix'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="space-y-4 p-3">
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
                onUpdate(question.id, {promptText: event.target.value})
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
                onUpdate(question.id, {questionType: event.target.value as QuestionType})
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
                {question.choices.map((choice) => (
                  <li key={choice.id} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name={`correct-${question.id}`}
                      checked={choice.isCorrect}
                      aria-label={`Mark choice ${choice.label} correct`}
                      className="size-4 shrink-0 accent-[var(--accent)]"
                      onChange={() =>
                        onUpdate(question.id, {
                          choices: question.choices.map((other) => ({
                            ...other,
                            isCorrect: other.id === choice.id,
                          })),
                          correctAnswer: choice.label,
                        })
                      }
                    />
                    <span className="w-5 shrink-0 text-sm text-muted">{choice.label}</span>
                    <input
                      type="text"
                      aria-label={`Text for choice ${choice.label}`}
                      className="field min-w-0 flex-1"
                      value={choice.text}
                      onChange={(event) =>
                        onUpdate(question.id, {
                          choices: question.choices.map((other) =>
                            other.id === choice.id
                              ? {...other, text: event.target.value}
                              : other,
                          ),
                        })
                      }
                    />
                    <button
                      type="button"
                      aria-label={`Remove choice ${choice.label}`}
                      className="btn-compact shrink-0 rounded px-1 text-sm text-muted hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      onClick={() =>
                        onUpdate(question.id, {
                          choices: question.choices
                            .filter((other) => other.id !== choice.id)
                            .map((other, i) => ({...other, label: CHOICE_LABELS[i]})),
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
                  className="mt-2 rounded-xl px-2 py-1 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  onClick={() =>
                    onUpdate(question.id, {
                      choices: [
                        ...question.choices,
                        {
                          id: nextChoiceKey(),
                          label: CHOICE_LABELS[question.choices.length],
                          text: '',
                          isCorrect: false,
                        },
                      ],
                    })
                  }
                >
                  Add choice
                </button>
              )}
            </fieldset>
          )}

          {question.questionType !== 'multiple_choice' && (
            <div>
              <label className="label" htmlFor={`answer-${question.id}`}>
                Correct answer
              </label>
              <input
                id={`answer-${question.id}`}
                type="text"
                autoComplete="off"
                className="field"
                value={question.correctAnswer ?? ''}
                onChange={(event) =>
                  onUpdate(question.id, {correctAnswer: event.target.value || null})
                }
              />
            </div>
          )}

          <TopicPicker
            topics={topics}
            value={question.topicId}
            onChange={(topicId) => onUpdate(question.id, {topicId})}
          />

          <button
            type="button"
            className="btn-compact rounded px-1 text-sm text-muted underline underline-offset-2 hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onClick={() => onRemove(question.id)}
          >
            Delete this question
          </button>
        </div>
      )}
    </li>
  )
})

const VIRTUALIZE_THRESHOLD = 40

const ESTIMATED_ROW_HEIGHT = 132

export interface QuestionListHandle {
  scrollToId: (id: string) => void
}

interface QuestionListProps {
  questions: EditableQuestion[]
  expandedId: string | null
  selectedId: string | null
  topics: TopicChoice[]
  topicById: Map<string, TopicChoice>
  onUpdate: (id: string, patch: Partial<EditableQuestion>) => void
  onRemove: (id: string) => void
  onFocus: (id: string, pageId: string | null) => void
  onToggleExpanded: (id: string, pageId: string | null) => void
  registerRef: (id: string, node: HTMLLIElement | null) => void
}

const QuestionList = forwardRef<QuestionListHandle, QuestionListProps>(function QuestionList(
  {
    questions,
    expandedId,
    selectedId,
    topics,
    topicById,
    onUpdate,
    onRemove,
    onFocus,
    onToggleExpanded,
    registerRef,
  },
  handleRef,
) {
  const virtualize = questions.length > VIRTUALIZE_THRESHOLD

  const listRef = useRef<HTMLUListElement>(null)

  const [scrollMargin, setScrollMargin] = useState(0)
  useLayoutEffect(() => {
    if (virtualize) setScrollMargin(listRef.current?.offsetTop ?? 0)
  }, [virtualize])

  const expandedIndex = expandedId ? questions.findIndex((q) => q.id === expandedId) : -1

  const rangeExtractor = useCallback(
    (range: Range) => {
      const base = defaultRangeExtractor(range)
      if (expandedIndex >= 0 && !base.includes(expandedIndex)) {
        return [...base, expandedIndex].sort((a, b) => a - b)
      }
      return base
    },
    [expandedIndex],
  )

  const virtualizer = useWindowVirtualizer({
    count: questions.length,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 6,
    gap: 12,
    scrollMargin,
    rangeExtractor,
    enabled: virtualize,
  })

  useImperativeHandle(
    handleRef,
    () => ({
      scrollToId: (id: string) => {
        if (!virtualize) return // every row is already mounted; nothing to do
        const index = questions.findIndex((q) => q.id === id)
        if (index >= 0) virtualizer.scrollToIndex(index, {align: 'center'})
      },
    }),
    [virtualize, questions, virtualizer],
  )

  const card = (question: EditableQuestion, extra?: {style: CSSProperties; index: number}) => (
    <QuestionCard
      key={question.id}
      question={question}
      expanded={expandedId === question.id}
      selected={selectedId === question.id}
      topic={question.topicId ? (topicById.get(question.topicId) ?? null) : null}
      topics={topics}
      onUpdate={onUpdate}
      onRemove={onRemove}
      onFocus={onFocus}
      onToggleExpanded={onToggleExpanded}
      registerRef={registerRef}
      style={extra?.style}
      dataIndex={extra?.index}
    />
  )

  if (!virtualize) {
    return <ul className="space-y-3">{questions.map((question) => card(question))}</ul>
  }

  return (
    <ul ref={listRef} style={{position: 'relative', height: virtualizer.getTotalSize()}}>
      {virtualizer.getVirtualItems().map((virtualRow) =>
        card(questions[virtualRow.index], {
          index: virtualRow.index,
          style: {
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            transform: `translateY(${virtualRow.start - scrollMargin}px)`,
          },
        }),
      )}
    </ul>
  )
})


interface Props {
  worksheetId: string
  worksheetTitle: string
  pages: EditablePage[]
  initialQuestions: EditableQuestion[]
  topics: TopicChoice[]
}

export default function EditClient({
  worksheetId,
  worksheetTitle,
  pages,
  initialQuestions,
  topics,
}: Props) {
  const editor = useQuestionEditor(worksheetId, initialQuestions)

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(
    initialQuestions[0]?.id ?? null,
  )
  const [pageIndex, setPageIndex] = useState(0)

  const [linesByPage, setLinesByPage] = useState<Map<string, TextLine[]>>(() => {
    const seeded = new Map<string, TextLine[]>()
    if (pages[0]) seeded.set(pages[0].id, pages[0].textLines)
    return seeded
  })
  const requestedPages = useRef(new Set(linesByPage.keys()))

  useEffect(() => {
    const current = pages[pageIndex]
    if (!current || requestedPages.current.has(current.id)) return
    requestedPages.current.add(current.id)

    let cancelled = false

    fetch(`/api/worksheets/${worksheetId}/pages/${current.id}/lines`)
      .then((response) => (response.ok ? response.json() : Promise.reject(response)))
      .then((body: {textLines: TextLine[]}) => {
        if (cancelled) return
        setLinesByPage((prev) => new Map(prev).set(current.id, body.textLines))
      })
      .catch(() => {
        requestedPages.current.delete(current.id)
      })

    return () => {
      cancelled = true
    }
  }, [pageIndex, pages, worksheetId])

  const cardRefs = useRef(new Map<string, HTMLLIElement>())
  const questionListRef = useRef<QuestionListHandle>(null)

  const topicById = useMemo(
    () => new Map(topics.map((topic) => [topic.id, topic])),
    [topics],
  )

  const {questions, update, removeQuestion, createQuestion} = editor

  const questionsRef = useRef(questions)
  useEffect(() => {
    questionsRef.current = questions
  }, [questions])

  const registerRef = useCallback((id: string, node: HTMLLIElement | null) => {
    if (node) cardRefs.current.set(id, node)
    else cardRefs.current.delete(id)
  }, [])

  const focusQuestion = useCallback(
    (id: string, pageId: string | null) => {
      setSelectedId(id)
      const index = pages.findIndex((p) => p.id === pageId)
      if (index >= 0) setPageIndex(index)

      cardRefs.current.get(id)?.scrollIntoView({block: 'nearest', behavior: 'smooth'})
      questionListRef.current?.scrollToId(id)
    },
    [pages],
  )

  const toggleExpanded = useCallback(
    (id: string, pageId: string | null) => {
      setExpandedId((current) => (current === id ? null : id))
      focusQuestion(id, pageId)
    },
    [focusQuestion],
  )

  const [undoable, setUndoable] = useState<{id: string; label: string} | null>(null)

  const remove = useCallback(
    (id: string) => {
      const going = questionsRef.current.find((question) => question.id === id)

      setSelectedId((current) => (current === id ? null : current))
      setUndoable(going ? {id, label: `question ${questionLabel(going)}`} : null)
      void removeQuestion(id)
    },
    [removeQuestion],
  )

  useEffect(() => {
    if (!undoable) return
    const timer = setTimeout(() => setUndoable(null), UNDO_WINDOW_MS)
    return () => clearTimeout(timer)
  }, [undoable])

  const page = pages[pageIndex]

  const add = useCallback(
    async (bbox: BBox | null, promptText: string) => {
      if (!page) return
      const id = await createQuestion(page.id, bbox, promptText)
      if (!id) return
      setSelectedId(id)
      setExpandedId(id)
    },
    [page, createQuestion],
  )

  if (!page) {
    return (
      <p className="card px-4 py-6 text-sm text-muted">
        This worksheet has no pages. Upload it again.
      </p>
    )
  }

  const linesReady = linesByPage.has(page.id)
  const pageWithLines = {...page, textLines: linesByPage.get(page.id) ?? []}

  const untagged = questions.filter((question) => !question.topicId).length

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_28rem]">
      <PageCanvas
        page={pageWithLines}
        linesReady={linesReady}
        pageNumber={page.pageNumber}
        pageCount={pages.length}
        worksheetTitle={worksheetTitle}
        canGoBack={pageIndex > 0}
        canGoForward={pageIndex < pages.length - 1}
        onBack={() => setPageIndex((index) => index - 1)}
        onForward={() => setPageIndex((index) => index + 1)}
        onSelect={(bbox, promptText) => void add(bbox, promptText)}
      />

      <section aria-labelledby="questions-heading" className="min-w-0 space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="questions-heading" className="text-sm font-medium">
            <span className="tabular-nums">{questions.length}</span>{' '}
            {questions.length === 1 ? 'question found' : 'questions found'}
          </h2>
          <span aria-live="polite" className="text-sm text-muted">
            {editor.saveState === 'saving' && 'Saving…'}
            {editor.saveState === 'saved' && 'Saved'}
            {editor.saveState === 'error' && 'Not saved'}
          </span>
        </div>

        {editor.error && (
          <p
            role="alert"
            className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            {editor.error}
          </p>
        )}

        {undoable && (
          <div
            role="status"
            className="flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm"
          >
            <span>Removed {undoable.label}.</span>
            <button
              type="button"
              className="btn btn-secondary h-8 shrink-0 px-3 text-sm"
              onClick={() => {
                editor.restoreQuestion(undoable.id)
                setUndoable(null)
              }}
            >
              Undo
            </button>
          </div>
        )}

        {questions.length === 0 && (
          <p className="rounded-2xl card-sunk px-3 py-8 text-center text-sm text-muted">
            Nothing was picked up from this page. Drag a box around a question to add
            it by hand.
          </p>
        )}

        <QuestionList
          ref={questionListRef}
          questions={questions}
          expandedId={expandedId}
          selectedId={selectedId}
          topics={topics}
          topicById={topicById}
          onUpdate={update}
          onRemove={remove}
          onFocus={focusQuestion}
          onToggleExpanded={toggleExpanded}
          registerRef={registerRef}
        />

        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => void add(null, '')}
        >
          Add a question by hand
        </button>

        <div className="inset-safe-bottom -mx-1 bg-bg px-1 pt-3">
          {untagged > 0 && (
            <p className="hint mb-2">
              <span className="tabular-nums">{untagged}</span> still have no topic. They
              will not count towards any of your weak areas until one is set.
            </p>
          )}
          <button
            type="button"
            className="btn btn-primary touch-manipulation"
            disabled={questions.length === 0 || editor.confirming}
            onClick={() => void editor.confirm()}
          >
            {editor.confirming
              ? 'Confirming…'
              : `Looks right, mark ${questions.length} ${
                  questions.length === 1 ? 'question' : 'questions'
                }`}
          </button>
        </div>
      </section>
    </div>
  )
}
