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
      { question: EditableQuestion; index: number; timer: ReturnType<typeof setTimeout> }
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
          headers: { 'Content-Type': 'application/json' },
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

      const next = { ...current, ...patch }

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
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!response.ok) throw new Error('Create failed')

        const { questionId } = (await response.json()) as { questionId: string }

        questionsRef.current = [
          ...questionsRef.current,
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
    restoreQuestion,
    confirm,
    setError,
  }
}
