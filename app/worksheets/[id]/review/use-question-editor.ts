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
  /**
   * Puts a removed question back where it was, if its row is still there.
   *
   * False means the window has closed and the delete has gone, so whatever
   * offered the undo has to say so rather than appear to do nothing.
   */
  restoreQuestion: (id: string) => boolean
  confirm: () => Promise<void>
  setError: (message: string | null) => void
}

const SAVE_DEBOUNCE_MS = 600

/**
 * How long a removed question can still be brought back.
 *
 * The row is not deleted until this elapses, which is what makes the undo a
 * local splice. Deleting immediately and recreating on undo would not give back
 * the same question: the create route's schema has no `printedNumber`, so the
 * number printed on the paper would be lost and the card would relabel itself
 * with its ordinal.
 */
export const UNDO_WINDOW_MS = 8000

/**
 * Kept as a constant because {@link useQuestionEditor} both raises and clears
 * it, and clearing works by recognising it.
 */
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

/**
 * Which letter `correctAnswer` should name once the options have been relabelled.
 *
 * Removing an option relabels the ones below it, and the letter stored on the
 * question was left pointing at whichever option now holds it: on a four option
 * question answered B, deleting A moved the stored answer onto what the student
 * had read as C. The option the letter named is found in the old list and
 * followed into the new one by its text, so the letter travels with it, and the
 * answer is cleared when that option is the one that went.
 *
 * Only when the labels actually changed. Typing in an option's text sends the
 * whole list through here too, and matching by text across that edit would fail
 * to find anything and throw away a perfectly good answer.
 *
 * Two options with identical text are the one case this cannot resolve, and it
 * clears rather than guesses. That pair is a duplicate the extractor should not
 * have produced, and losing a tick on it is recoverable in a way that silently
 * marking the wrong option correct is not.
 */
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

  // Not a label off this list at all. The same field holds the typed answer for
  // every question type that has no options, and none of this is about that.
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
 *
 * A removed question is the other kind of pending write. Its row survives for
 * {@link UNDO_WINDOW_MS} so that undoing is a splice rather than a recreate, and
 * the same three paths that get an edit out get the delete out with it.
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

  /** Questions taken off the list whose DELETE has not been sent yet. */
  const pendingRemovals = useRef(
    new Map<
      string,
      { question: EditableQuestion; index: number; timer: ReturnType<typeof setTimeout> }
    >(),
  )

  const settle = useCallback(() => {
    // `pendingRemovals` counts too. A delete is held for the undo window before
    // its request goes out, so without this the caption read "Saved" the
    // instant a question was removed, with the DELETE not yet sent and up to
    // eight seconds to wait. Force-quitting inside that window brought the
    // question back, having been told it was saved.
    if (
      owed.current.size > 0 ||
      inFlight.current !== 0 ||
      pendingRemovals.current.size > 0
    ) {
      return
    }

    setSaveState('saved')

    // The save banner used to stay up for the rest of the session: one dropped
    // request left "Could not save that change" on screen while every later
    // edit went through fine, so the screen was telling the student their work
    // was lost while it was being saved in front of them. Cleared only once
    // nothing is owed and nothing is in flight, because until then it is true.
    //
    // Only this message. A failed confirm is still a failed confirm after an
    // unrelated edit lands, and `confirm` clears its own on the next attempt.
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
        setError(SAVE_FAILED)
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

  /**
   * Sends the DELETE for a question already gone from the list.
   *
   * `keepalive` because the same call has to work from the unmount path, where
   * there may be no page left to hold the request open.
   */
  const commitRemoval = useCallback(async (id: string) => {
    const pending = pendingRemovals.current.get(id)
    if (!pending) return

    clearTimeout(pending.timer)

    /*
     * The entry stays until the server confirms, and `ok` is checked.
     *
     * This used to drop the entry first and swallow every error, so a DELETE
     * that came back 500 looked exactly like one that worked. `fetchJson` only
     * throws on 401, so the catch never ran and nothing read `ok`. With the
     * entry already gone, no timer, no flush and no unmount path would retry
     * it: the question stayed in the database, `confirm` then marked every row
     * on the worksheet verified, and it came back in the student's study queue.
     * The screen said "Saved" throughout.
     */
    try {
      const response = await fetchJson(`/api/questions/${id}`, {
        method: 'DELETE',
        keepalive: true,
      })

      // 404 counts as gone: something else already removed it, which is the
      // outcome this was asking for.
      if (!response.ok && response.status !== 404) {
        throw new Error(`Delete failed (${response.status})`)
      }

      pendingRemovals.current.delete(id)
      settle()
    } catch {
      // Left in `pendingRemovals`, so `flush` and the unmount path still owe
      // it. Said out loud rather than retried on a timer: the row is off the
      // screen, and a student who cannot see it cannot be asked to wait.
      setError(SAVE_FAILED)
      setSaveState('error')
    }
  }, [settle])

  /**
   * Writes everything still owed and waits for it.
   *
   * Deletes included, and awaited rather than left to their timers: `confirm`
   * counts the questions on the server, so a row the student has already
   * removed would be counted, marked verified, and only then deleted.
   */
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

    // Fire and forget, with keepalive: by the time these run there may be no
    // page left to await them on.
    //
    // The removals go too. A delete waiting out its undo window is a delete the
    // student has already asked for, and letting the page take it away would
    // put the question back on the next visit.
    const flushBeyondThePage = () => {
      for (const question of debts.values()) void send(question, true)
      for (const id of [...removals.keys()]) void commitRemoval(id)
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
  }, [send, commitRemoval])

  const update = useCallback(
    (id: string, patch: Partial<EditableQuestion>) => {
      const current = questionsRef.current.find((question) => question.id === id)
      if (!current) return

      const next = { ...current, ...patch }

      // A patch that names both has decided for itself: ticking an option sends
      // its label alongside the list. Only a bare list of options needs the
      // stored letter moved to keep up with it.
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

  /**
   * The next free ordinal, claimed before the request rather than after it.
   *
   * Held past the highest one handed out this session, so two creates issued
   * inside a single round trip get different numbers even though neither has
   * reached the list yet.
   */
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
        // Read off the ref because the server needs this before the state
        // exists, and one past the highest in use rather than one past the
        // count. Ordinals are not reissued when a question is deleted, so on a
        // five question sheet with question 3 removed, `length + 1` was 5 and
        // question 5 already had it. Two rows on the same ordinal sort against
        // each other arbitrarily, and both show "5" on any paper that prints no
        // numbers of its own.
        //
        // Nothing repairs it afterwards. `renumberQuestions` does rewrite every
        // ordinal from page and printed number, but it runs in the extraction
        // pipeline before this screen is ever shown, and the confirm route does
        // not call it.
        //
        // Reserved through `reservedOrdinal` rather than read straight off the
        // list, because the list is only appended to once the POST comes back.
        // Two creates inside one round trip, which is a double-click on "Add a
        // Question by Hand" or two quick drags on the page, both read the same
        // highest and both minted the same number.
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
    [worksheetId, settle, reserveOrdinal],
  )

  /**
   * Takes a question off the list now and deletes the row in a moment.
   *
   * The delay is the undo: nothing is recreated on the way back, because a
   * recreated question is not the one that was deleted. See
   * {@link UNDO_WINDOW_MS}. Still returns a promise, even though there is no
   * longer anything to await, because callers hold it that way and the delete
   * is finished off by `flush` and by unmount rather than by them.
   */
  const removeQuestion = useCallback(
    async (id: string) => {
      // Drop any debt first, or the pending PATCH races the delete and fails
      // against a row that is no longer there.
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

      // Deleting a question is the other way its debt gets discharged, and the
      // only one that leaves nothing to answer for it. Without this, a question
      // whose save had failed took the "Could not save that change" banner with
      // it and left it on screen with nothing left to save.
      settle()
    },
    [commitRemoval, settle],
  )

  const restoreQuestion = useCallback((id: string) => {
    const pending = pendingRemovals.current.get(id)
    if (!pending) return false

    clearTimeout(pending.timer)
    pendingRemovals.current.delete(id)

    // No write. The row was never deleted, so putting the card back where it
    // was is the whole of it, and the question keeps its id: anything the
    // screen had keyed by that id still points at it.
    //
    // The remembered position is a best effort. Removing something above it in
    // the meantime shifts it by one, which reading the page again settles,
    // because the order on screen comes from the ordinal on the row.
    const next = [...questionsRef.current]
    next.splice(pending.index, 0, pending.question)
    questionsRef.current = next
    setQuestions(next)

    return true
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
    restoreQuestion,
    confirm,
    setError,
  }
}
