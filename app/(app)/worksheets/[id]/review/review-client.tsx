'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { TopicChoice } from '@/components/topic-picker'
import type { BBox, TextLine } from '@/lib/db/schema'

import PageCanvas from './page-canvas'
import QuestionList from './question-list'
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

/**
 * The markup screen: a page on the left, the questions read off it on the
 * right.
 *
 * This file used to be all of it, at 676 lines and nine jobs. What is left
 * here is the part that genuinely joins the two halves: which page is showing,
 * which card is selected, and which one is open for editing. The writes live
 * in {@link useQuestionEditor}, the drag in {@link PageCanvas}, and the cards
 * in {@link QuestionList}, whose memo holds only while every handler below
 * keeps its identity between keystrokes. `update` was the first one that had to
 * be made to; `focusQuestion` was the second, and was still rebuilding itself
 * long after the split had supposedly paid for itself.
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

  // Only page one arrives with real lines (page.tsx). Every other page's
  // come from here, the first time the reader actually turns to it, rather
  // than all at once on a screen that might only ever be scrolled through
  // one page at a time.
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
        // Left off the requested set, so turning back to this page (which
        // re-fires this effect) tries again rather than leaving the drag
        // disabled here for the rest of the session over one bad request.
        requestedPages.current.delete(current.id)
      })

    return () => {
      cancelled = true
    }
  }, [pageIndex, pages, worksheetId])

  const cardRefs = useRef(new Map<string, HTMLLIElement>())

  const topicById = useMemo(
    () => new Map(topics.map((topic) => [topic.id, topic])),
    [topics],
  )

  const { questions, update, removeQuestion, createQuestion } = editor

  // Mirrored into a ref so `remove` can read the list without taking it as a
  // dependency. `remove` is one of the nine props each card is handed, and a
  // new identity on every keystroke is all it takes to defeat the memo.
  const questionsRef = useRef(questions)
  useEffect(() => {
    questionsRef.current = questions
  }, [questions])

  const registerRef = useCallback((id: string, node: HTMLLIElement | null) => {
    if (node) cardRefs.current.set(id, node)
    else cardRefs.current.delete(id)
  }, [])

  // The page comes in from the card rather than being looked up here. Finding
  // it needed `questions`, so this was a new function on every keystroke, and
  // `toggleExpanded` below it too: two of the nine props each card is handed
  // changed identity on every edit, which is all it takes to defeat the memo on
  // the other 113 cards. `pages` is a prop, so it holds for the life of the
  // screen.
  const focusQuestion = useCallback(
    (id: string, pageId: string | null) => {
      setSelectedId(id)
      const index = pages.findIndex((p) => p.id === pageId)
      if (index >= 0) setPageIndex(index)
      cardRefs.current.get(id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
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

  /**
   * The question the undo offer is currently about, if any.
   *
   * Captured before the removal, because afterwards the card is out of the list
   * and there is nothing left to read a label off.
   */
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

  // The offer expires with the window the hook holds the row for, so the
  // button cannot outlive the thing it would undo.
  useEffect(() => {
    if (!undoable) return
    const timer = setTimeout(() => setUndoable(null), UNDO_WINDOW_MS)
    return () => clearTimeout(timer)
  }, [undoable])

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
            className="rounded-xl border border-danger/40 px-3 py-2 text-sm text-danger"
          >
            {editor.error}
          </p>
        )}

        {/*
          The undo the delete window exists for. Without a control the window
          was invisible: deleting was merely deferred by eight seconds and
          nobody could take it back, which is worse than deleting at once
          because the caption said "Saved" while the request had not been sent.
        */}
        {undoable && (
          <div
            role="status"
            className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2 text-sm"
          >
            <span>Removed {undoable.label}.</span>
            <button
              type="button"
              className="btn btn-secondary h-8 shrink-0 px-3 text-sm"
              onClick={() => {
                // A false return means the window closed and the row is
                // already gone, which is not an error, only too late. The
                // offer goes either way.
                editor.restoreQuestion(undoable.id)
                setUndoable(null)
              }}
            >
              Undo
            </button>
          </div>
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
          Add a question by hand
        </button>

        <div className="inset-safe-bottom sticky bottom-0 -mx-1 border-t border-border bg-bg px-1 pt-3">
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
