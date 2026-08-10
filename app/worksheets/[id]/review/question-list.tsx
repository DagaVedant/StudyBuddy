'use client'

import { memo } from 'react'

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
}: CardProps) {
  const correct = question.choices.find((choice) => choice.isCorrect)

  return (
    <li
      ref={(node) => registerRef(question.id, node)}
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
                      className="shrink-0 rounded px-1 text-sm text-muted hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
            className="rounded px-1 text-sm text-muted underline underline-offset-2 hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onClick={() => onRemove(question.id)}
          >
            Delete this question
          </button>
        </div>
      )}
    </li>
  )
})

export default function QuestionList({
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
}: {
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
}) {
  return (
    <ul className="space-y-3">
      {questions.map((question) => (
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
        />
      ))}
    </ul>
  )
}
