'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { BBox } from '@/lib/db/schema'

import type { EditableQuestion, QuestionType } from './types'

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

/**
 * Every write this page makes, and nothing about how it looks.
 *
 * Pulled out of the component for two reasons. It was the half of a 676 line
 * file that had nothing to do with rendering, and `update` used to close over
 * `questions`, so a new one was built on every keystroke and no question card
 * downstream of it could usefully be memoized. The functional `setQuestions`
 * below is what makes that identity stable, and so what makes {@link
 * QuestionCard} memoizable.
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

  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  useEffect(() => {
    const timers = saveTimers.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
    }
  }, [])

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
      }, SAVE_DEBOUNCE_MS),
    )
  }, [])

  const update = useCallback(
    (id: string, patch: Partial<EditableQuestion>) => {
      setQuestions((list) => {
        const current = list.find((question) => question.id === id)
        if (!current) return list

        const next = { ...current, ...patch }
        persist(next)
        return list.map((question) => (question.id === id ? next : question))
      })
    },
    [persist],
  )

  const createQuestion = useCallback(
    async (pageId: string, bbox: BBox | null, promptText: string) => {
      setError(null)

      const body = {
        pageId,
        // Read inside the updater below would be cleaner, but the server needs
        // this before the state exists. Renumbering settles it either way:
        // `renumberQuestions` rewrites every ordinal from page and printed
        // number once the worksheet is confirmed.
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
          {
            ...body,
            id: questionId,
            correctAnswer: null,
            topicId: null,
            printedNumber: null,
          },
        ])
        setSaveState('saved')
        return questionId
      } catch {
        setError('Could not add that question. Try again.')
        return null
      }
    },
    [worksheetId, questions.length],
  )

  const removeQuestion = useCallback(async (id: string) => {
    setQuestions((current) => current.filter((question) => question.id !== id))
    await fetch(`/api/questions/${id}`, { method: 'DELETE' }).catch(() => {})
  }, [])

  const confirm = useCallback(async () => {
    setConfirming(true)
    setError(null)
    // Let debounced saves land before the worksheet is locked in.
    await new Promise((resolve) => setTimeout(resolve, SAVE_DEBOUNCE_MS + 100))

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
  }, [worksheetId, router])

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
