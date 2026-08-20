'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { TopicChoice } from '@/components/topic-picker'
import type { BBox, TextLine } from '@/lib/db/schema'

import PageCanvas from './page-canvas'
import QuestionList, { type QuestionListHandle } from './question-list'
import { questionLabel, type EditablePage, type EditableQuestion } from './types'
import { UNDO_WINDOW_MS, useQuestionEditor } from './use-question-editor'

export type { EditablePage, EditableQuestion } from './types'

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
      .then((body: { textLines: TextLine[] }) => {
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

  const { questions, update, removeQuestion, createQuestion } = editor

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

      cardRefs.current.get(id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
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

  const [undoable, setUndoable] = useState<{ id: string; label: string } | null>(null)

  const remove = useCallback(
    (id: string) => {
      const going = questionsRef.current.find((question) => question.id === id)

      setSelectedId((current) => (current === id ? null : current))
      setUndoable(going ? { id, label: `question ${questionLabel(going)}` } : null)
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
  const pageWithLines = { ...page, textLines: linesByPage.get(page.id) ?? [] }

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
