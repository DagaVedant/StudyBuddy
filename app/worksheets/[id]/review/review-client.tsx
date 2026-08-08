'use client'

import { useCallback, useMemo, useRef, useState } from 'react'

import type { TopicChoice } from '@/components/topic-picker'
import type { BBox } from '@/lib/db/schema'

import PageCanvas from './page-canvas'
import QuestionList from './question-list'
import type { EditablePage, EditableQuestion } from './types'
import { useQuestionEditor } from './use-question-editor'

export type { EditablePage, EditableQuestion } from './types'

interface Props {
  worksheetId: string
  worksheetTitle: string
  pages: EditablePage[]
  initialQuestions: EditableQuestion[]
  topics: TopicChoice[]
}

/**
 * The markup screen: a page on the left, the questions read off it on the
 * right.
 *
 * This file used to be all of it, at 676 lines and nine jobs. What is left
 * here is the part that genuinely joins the two halves: which page is showing,
 * which card is selected, and which one is open for editing. The writes live
 * in {@link useQuestionEditor}, the drag in {@link PageCanvas}, and the cards
 * in {@link QuestionList}, which can now be memoized because `update` no
 * longer changes identity on every keystroke.
 */
export default function ReviewClient({
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

  const cardRefs = useRef(new Map<string, HTMLLIElement>())

  const topicById = useMemo(
    () => new Map(topics.map((topic) => [topic.id, topic])),
    [topics],
  )

  const { questions, update, removeQuestion, createQuestion } = editor

  const registerRef = useCallback((id: string, node: HTMLLIElement | null) => {
    if (node) cardRefs.current.set(id, node)
    else cardRefs.current.delete(id)
  }, [])

  const focusQuestion = useCallback(
    (id: string) => {
      setSelectedId(id)
      const question = questions.find((q) => q.id === id)
      const index = pages.findIndex((p) => p.id === question?.pageId)
      if (index >= 0) setPageIndex(index)
      cardRefs.current.get(id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    },
    [questions, pages],
  )

  const toggleExpanded = useCallback(
    (id: string) => {
      setExpandedId((current) => (current === id ? null : id))
      focusQuestion(id)
    },
    [focusQuestion],
  )

  const remove = useCallback(
    (id: string) => {
      setSelectedId((current) => (current === id ? null : current))
      void removeQuestion(id)
    },
    [removeQuestion],
  )

  const page = pages[pageIndex]

  // Null bbox for one added by hand: it is not anywhere on the page, and a
  // zero-size box would claim it was at the top-left corner.
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

  const untagged = questions.filter((question) => !question.topicId).length

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_28rem]">
      <PageCanvas
        page={page}
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
            className="rounded-xl border border-danger/40 px-3 py-2 text-sm text-danger"
          >
            {editor.error}
          </p>
        )}

        {questions.length === 0 && (
          <p className="rounded-2xl border border-dashed border-border px-3 py-8 text-center text-sm text-muted">
            Nothing was picked up from this page. Drag a box around a question to add
            it by hand.
          </p>
        )}

        <QuestionList
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
          Add a Question by Hand
        </button>

        <div className="sticky bottom-0 -mx-1 border-t border-border bg-bg px-1 pb-1 pt-3">
          {untagged > 0 && (
            <p className="hint mb-2">
              <span className="tabular-nums">{untagged}</span> still have no topic. They
              will show up on the dashboard under a broader heading.
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
              : `Looks Right, Mark ${questions.length} ${
                  questions.length === 1 ? 'Question' : 'Questions'
                }`}
          </button>
        </div>
      </section>
    </div>
  )
}
