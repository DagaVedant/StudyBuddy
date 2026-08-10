'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { BBox } from '@/lib/db/schema'

import type { EditableQuestion, QuestionType } from './types'
import { fetchJson } from '@/lib/client/fetch-json'

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
  confirm: () => Promise<void>
  setError: (message: string | null) => void
}

const SAVE_DEBOUNCE_MS = 600

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

/**
 * Every write this page makes, and nothing about how it looks.
 *
 * Pulled out of the component for two reasons. It was the half of a 676 line
 * file that had nothing to do with rendering, and `update` used to close over
 * `questions`, so a new one was built on every keystroke and no question card
 * downstream of it could usefully be memoized. The ref below is what makes that
 * identity stable, and so what makes {@link QuestionCard} memoizable.
 *
 * Edits are debounced, which means there is always a window where the newest
 * keystroke is only in the browser. Three things keep that window from eating
 * the edit: anything still owed is flushed on unmount and on pagehide, the
 * flush uses `keepalive` so the request outlives the page, and the caption says
 * "Saving…" from the keystroke rather than from the request, so it never reads
 * "Saved" while something is still owed.
 */
export function useQuestionEditor(
  worksheetId: string,
  initialQuestions: EditableQuestion[],
): QuestionEditor {
  const router = useRouter()

  const [questions, setQuestions] = useState(initialQuestions)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  // The synchronous copy. `update` reads and writes this rather than reading
  // the state variable, so two edits in one tick cannot lose the first, and so
  // that nothing has to be recomputed when `questions` changes.
  const questionsRef = useRef(initialQuestions)

  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  /** The newest unsaved version of each question, by id. */
  const owed = useRef(new Map<string, EditableQuestion>())
  const inFlight = useRef(0)

  const settle = useCallback(() => {
    if (owed.current.size === 0 && inFlight.current === 0) setSaveState('saved')
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
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patchBody(question)),
          // Lets the request finish after this page is gone. The body is a
          // single question, far inside the 64KB cap the option carries.
          keepalive,
        })
        if (!response.ok) throw new Error('Save failed')

        // Only clear the debt if this is still the newest version. A keystroke
        // that landed while the request was in flight has already replaced it
        // and is owed in its own right.
        if (owed.current.get(question.id) === question) owed.current.delete(question.id)

        inFlight.current -= 1
        settle()
      } catch {
        inFlight.current -= 1
        setSaveState('error')
        setError('Could not save that change. Check your connection and try again.')
      }
    },
    [settle],
  )

  const persist = useCallback(
    (question: EditableQuestion) => {
      owed.current.set(question.id, question)
      // Said now, not when the request starts. The caption used to sit on
      // "Saved" through the whole debounce, which is the opposite of what is
      // true: the edit is at its least safe in exactly that window.
      setSaveState('saving')

      clearTimeout(saveTimers.current.get(question.id))
      saveTimers.current.set(
        question.id,
        setTimeout(() => void send(question), SAVE_DEBOUNCE_MS),
      )
    },
    [send],
  )

  /** Writes everything still owed and waits for it. */
  const flush = useCallback(async () => {
    await Promise.all([...owed.current.values()].map((question) => send(question)))
  }, [send])

  useEffect(() => {
    const timers = saveTimers.current
    const debts = owed.current

    // Fire and forget, with keepalive: by the time these run there may be no
    // page left to await them on.
    const flushBeyondThePage = () => {
      for (const question of debts.values()) void send(question, true)
    }

    const onPageHide = () => flushBeyondThePage()
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushBeyondThePage()
    }

    // pagehide covers closing the tab and the back/forward cache;
    // visibilitychange covers a phone being locked or the app being switched
    // away from, which on mobile is where the page is most likely to be
    // discarded without ever hiding.
    window.addEventListener('pagehide', onPageHide)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      window.removeEventListener('pagehide', onPageHide)
      document.removeEventListener('visibilitychange', onVisibilityChange)

      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()

      // A client-side navigation unmounts this without any of the events
      // above, and used to drop the pending write on the floor.
      flushBeyondThePage()
    }
  }, [send])

  const update = useCallback(
    (id: string, patch: Partial<EditableQuestion>) => {
      const current = questionsRef.current.find((question) => question.id === id)
      if (!current) return

      const next = { ...current, ...patch }
      questionsRef.current = questionsRef.current.map((question) =>
        question.id === id ? next : question,
      )

      setQuestions(questionsRef.current)
      persist(next)
    },
    [persist],
  )

  const createQuestion = useCallback(
    async (pageId: string, bbox: BBox | null, promptText: string) => {
      setError(null)

      const body = {
        pageId,
        // Read off the ref because the server needs this before the state
        // exists. Renumbering settles it either way: `renumberQuestions`
        // rewrites every ordinal from page and printed number once the
        // worksheet is confirmed.
        ordinal: questionsRef.current.length + 1,
        promptText: promptText || 'New question',
        questionType: 'multiple_choice' as QuestionType,
        bbox,
        choices: [],
      }

      try {
        const response = await fetchJson(`/api/worksheets/${worksheetId}/questions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!response.ok) throw new Error('Create failed')

        const { questionId } = (await response.json()) as { questionId: string }

        questionsRef.current = [
          ...questionsRef.current,
          // Null rather than a made-up number: a question added by hand has no
          // number printed on the paper, so it falls back to its position.
          {
            ...body,
            id: questionId,
            correctAnswer: null,
            topicId: null,
            printedNumber: null,
          },
        ]
        setQuestions(questionsRef.current)
        settle()
        return questionId
      } catch {
        setError('Could not add that question. Try again.')
        return null
      }
    },
    [worksheetId, settle],
  )

  const removeQuestion = useCallback(async (id: string) => {
    // Drop any debt first, or the pending PATCH races the delete and fails
    // against a row that is no longer there.
    clearTimeout(saveTimers.current.get(id))
    saveTimers.current.delete(id)
    owed.current.delete(id)

    questionsRef.current = questionsRef.current.filter((question) => question.id !== id)
    setQuestions(questionsRef.current)

    await fetchJson(`/api/questions/${id}`, { method: 'DELETE' }).catch(() => {})
  }, [])

  const confirm = useCallback(async () => {
    setConfirming(true)
    setError(null)

    // Was a sleep for the debounce plus a margin, which is both slower than it
    // needs to be and not actually a guarantee. Waiting on the writes is.
    await flush()

    try {
      const response = await fetchJson(`/api/worksheets/${worksheetId}/confirm`, {
        method: 'POST',
      })
      const body = (await response.json()) as { next?: string; error?: string }
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
    confirm,
    setError,
  }
}
