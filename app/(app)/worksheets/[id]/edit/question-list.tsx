'use client'

import {
  forwardRef,
  memo,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import {
  defaultRangeExtractor,
  useWindowVirtualizer,
  type Range,
} from '@tanstack/react-virtual'

import TopicPicker, { type TopicChoice } from '@/components/topic-picker'
import { reflowText } from '@/lib/questions/reflow'
import { choiceLabel } from '@/lib/questions/shape'

import {
  CHOICE_LABELS,
  QUESTION_TYPES,
  questionLabel,
  type EditableQuestion,
  type QuestionType,
} from './types'

/**
 * A key for a choice that has no row yet.
 *
 * Only has to be unique for the life of the screen: it is a React key and the
 * server never sees it. A module counter satisfies that everywhere, which
 * `crypto.randomUUID` does not, being secure-context only.
 */
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
  /**
   * The page id travels with the question id because the parent would
   * otherwise have to search `questions` for it, and a handler that closes over
   * `questions` is rebuilt on every keystroke, which is exactly what the memo
   * below cannot survive.
   */
  onFocus: (id: string, pageId: string | null) => void
  onToggleExpanded: (id: string, pageId: string | null) => void
  registerRef: (id: string, node: HTMLLIElement | null) => void
  /**
   * Set only once the list is long enough to virtualize (see `QuestionList`
   * below). `measureRef` reports the row's real, post-render height back to
   * the virtualizer - collapsed and expanded rows differ by a lot, and an
   * estimate would leave every row after one that guessed wrong overlapping
   * or gapped. `style` and `dataIndex` are the virtualizer's own absolute
   * positioning and the index its resize observer keys measurements by.
   */
  measureRef?: (node: HTMLLIElement | null) => void
  style?: CSSProperties
  dataIndex?: number
}

/**
 * One question, summarised, with the editor behind a "Fix".
 *
 * Memoized, and that is the point of the whole split. Typing one character
 * into one prompt used to re-render every card on the worksheet, which on a
 * 114 question paper is most of a second per keystroke. The props here are all
 * either primitives or identities the parent holds stable, so React can skip
 * the 113 cards that did not change.
 */
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
        selected ? 'border-accent' : 'border-transparent'
      }`}
    >
      {/* Summary: what the AI actually pulled off the page. */}
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

        {/* One choice per line. Pills only fit choices that are a word or a
            number; a choice can be a whole rewritten sentence, and those used
            to run off the side of the card. */}
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

      {/* Editor: only when something needs correcting. */}
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
                onUpdate(question.id, { promptText: event.target.value })
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
                onUpdate(question.id, {
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
              {/* Keyed by id, and matched by id in every handler below. Both
                  used to be the row's position, and a position is not an
                  identity in a list you can delete out of the middle of: with
                  `key={index}`, removing C handed C's text box to what had been
                  D, so the caret, the selection and whatever the browser was
                  still holding for that field stayed where they were while the
                  text under them changed. */}
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
                              ? { ...other, text: event.target.value }
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
                          // The relabel stays positional on purpose: what is
                          // left after a removal has to read A, B, C with no
                          // gap, whatever it read before.
                          choices: question.choices
                            .filter((other) => other.id !== choice.id)
                            .map((other, i) => ({ ...other, label: CHOICE_LABELS[i] })),
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
                    onUpdate(question.id, {
                      choices: [
                        ...question.choices,
                        {
                          // Minted here. A choice added by hand has no
                          // `answer_choices` row to borrow an id from and needs
                          // a key the moment it is on screen; the row the save
                          // writes gets an id of its own that nothing reads
                          // back.
                          //
                          // A counter and not `crypto.randomUUID`, which is
                          // secure-context only: over http on a LAN address,
                          // which is how this screen gets tested on a real
                          // phone, it is undefined and Add Choice threw.
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
                Correct answer <span className="font-normal text-muted">(optional)</span>
              </label>
              <input
                id={`answer-${question.id}`}
                type="text"
                autoComplete="off"
                className="field"
                value={question.correctAnswer ?? ''}
                onChange={(event) =>
                  onUpdate(question.id, { correctAnswer: event.target.value || null })
                }
              />
            </div>
          )}

          <TopicPicker
            topics={topics}
            value={question.topicId}
            onChange={(topicId) => onUpdate(question.id, { topicId })}
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

/**
 * Below this threshold, the plain list. A worksheet this size never pays for
 * a virtualizer: the DOM cost of forty collapsed cards is not the problem
 * finding 48 named, and every row staying permanently mounted is one fewer
 * thing that can go wrong on the very screen where a lost edit costs the
 * most.
 */
const VIRTUALIZE_THRESHOLD = 40

/**
 * Rough collapsed-card height, in pixels, before the virtualizer has
 * measured a real one. Wrong by a little just means the scrollbar jumps
 * slightly on first paint; every row is re-measured off its own rendered
 * height (`measureRef`) the moment it mounts.
 */
const ESTIMATED_ROW_HEIGHT = 132

export interface QuestionListHandle {
  /** Brings a question into view even if it is not currently rendered. */
  scrollToId: (id: string) => void
}

interface Props {
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

/**
 * `useWindowVirtualizer` runs on every render regardless of `questions.length`,
 * even for a five-question worksheet that will never read its output: Rules
 * of Hooks rule out calling it only sometimes, and splitting the virtualized
 * path into a child component instead used to mean two `useImperativeHandle`
 * calls racing to write the same forwarded ref (child effects commit before
 * parent effects, so the parent's would have won and silently discarded the
 * virtualizer's real `scrollToId`). One component, one handle, and the
 * unvirtualized branch returns before any of the virtualizer's output is
 * used - the listener it attached costs a resize/scroll subscription, not a
 * render.
 *
 * Windows the *rendered* set, not the *mounted* set of anything mid-edit:
 * `rangeExtractor` always includes the expanded row even when scrolling has
 * carried it out of the naturally-computed range, so the one row that can
 * hold an unsaved keystroke never unmounts out from under the student typing
 * into it. Everything else is free to come and go - a collapsed card has
 * nothing in it a remount could lose.
 */
const QuestionList = forwardRef<QuestionListHandle, Props>(function QuestionList(
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

  // Measured after mount rather than assumed: this section sits below a
  // heading, an optional error banner and an optional undo toast, none of a
  // fixed height, so the offset from the top of the document is only known
  // once the browser has actually laid the page out.
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
        if (index >= 0) virtualizer.scrollToIndex(index, { align: 'center' })
      },
    }),
    [virtualize, questions, virtualizer],
  )

  const card = (question: EditableQuestion, extra?: { style: CSSProperties; index: number }) => (
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
    <ul ref={listRef} style={{ position: 'relative', height: virtualizer.getTotalSize() }}>
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

export default QuestionList
