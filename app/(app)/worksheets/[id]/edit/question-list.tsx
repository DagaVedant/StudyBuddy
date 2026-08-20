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

const VIRTUALIZE_THRESHOLD = 40

const ESTIMATED_ROW_HEIGHT = 132

export interface QuestionListHandle {
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
