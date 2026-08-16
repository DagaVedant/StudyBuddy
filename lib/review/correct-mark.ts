import { and, eq } from 'drizzle-orm'

import { answerChoices, attempts, questions, reviewCards } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'

import { scheduleFromOutcome, type Outcome } from './fsrs'

export interface Correction {
  questionId: string
  outcome: Outcome
  selectedChoiceId?: string | null
  freeTextAnswer?: string | null
}

export type CorrectionResult =
  | { ok: true; outcome: Outcome; rescheduled: boolean }
  | { ok: false; reason: 'no-question' | 'not-marked' }

/**
 * Change one question's recorded outcome, for the tap that went astray.
 *
 * The markup flow is built for speed: one tap per question, designed to fly
 * through forty of them (spec.md:381). It was also unrepeatable in three
 * independent places, each individually right, and together they meant a
 * mis-tap was permanent. There was no un-mark, re-mark, edit or reset anywhere
 * in the app, and the only recourse was deleting the worksheet and uploading it
 * again, which on the trial tier costs one of three lifetime credits.
 *
 * The loss is not cosmetic. That attempt feeds the FSRS schedule, the topic
 * accuracy, the Wilson-bounded weakness ranking and the Blooket export, and a
 * question marked `correct` by accident leaves the practice queue for good: the
 * queue's last clause is an `exists` over attempts with outcome wrong or
 * unsure, so nothing ever brings it back.
 *
 * One question at a time, and an update rather than an insert. The partial
 * unique index permits an update to the row it already holds and refuses a
 * second insert, which is the distinction that matters here: what must not
 * become possible again is re-submitting the whole paper, because that is what
 * pushed every review card forward on answers nobody gave.
 */
export async function correctMarkupAttempt(
  db: Db,
  userId: string,
  worksheetId: string,
  input: Correction,
): Promise<CorrectionResult> {
  // The worksheet as well as the question. Without the first clause this would
  // correct an attempt on somebody else's paper for anyone who could name a
  // question id.
  const [question] = await db
    .select({ id: questions.id })
    .from(questions)
    .where(
      and(eq(questions.worksheetId, worksheetId), eq(questions.id, input.questionId)),
    )
    .limit(1)

  if (!question) return { ok: false, reason: 'no-question' }

  const [existing] = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(
      and(
        eq(attempts.userId, userId),
        eq(attempts.questionId, input.questionId),
        eq(attempts.source, 'markup'),
      ),
    )
    .limit(1)

  // Nothing recorded means nothing to correct. Inserting one here would be a
  // way to mark a single question outside the flow that marks the paper, which
  // is the shape the unique index exists to keep to one submission.
  if (!existing) return { ok: false, reason: 'not-marked' }

  // A choice is only accepted if it belongs to the question being corrected.
  const [choice] = input.selectedChoiceId
    ? await db
        .select({ id: answerChoices.id })
        .from(answerChoices)
        .where(
          and(
            eq(answerChoices.id, input.selectedChoiceId),
            eq(answerChoices.questionId, input.questionId),
          ),
        )
        .limit(1)
    : []

  const now = new Date()
  let rescheduled = false

  await db.transaction(async (tx) => {
    await tx
      .update(attempts)
      .set({
        outcome: input.outcome,
        selectedChoiceId: choice?.id ?? null,
        freeTextAnswer: input.freeTextAnswer ?? null,
      })
      .where(eq(attempts.id, existing.id))

    /*
     * The schedule is rebuilt only if the student has not practised since.
     *
     * A card that has been through the review screen carries real history: they
     * answered it, FSRS moved it on, and rewriting that from the original mark
     * would throw away the more recent and more truthful of the two. Correcting
     * the record is still worth doing in that case, because queue membership
     * reads the attempt row directly and fixes itself either way.
     *
     * Where nothing has happened since, the card is exactly what the mis-tap
     * produced, so it is rebuilt from the corrected outcome as though the right
     * button had been tapped in the first place.
     */
    const [practised] = await tx
      .select({ id: attempts.id })
      .from(attempts)
      .where(
        and(
          eq(attempts.userId, userId),
          eq(attempts.questionId, input.questionId),
          eq(attempts.source, 'review'),
        ),
      )
      .limit(1)

    if (practised) return

    const { card } = scheduleFromOutcome(null, input.outcome, now)

    await tx
      .insert(reviewCards)
      .values({ userId, questionId: input.questionId, ...card })
      .onConflictDoUpdate({
        target: [reviewCards.userId, reviewCards.questionId],
        set: {
          ...card,
          // Cleared deliberately. "Got it" retires a card, and a student who
          // retired one they had marked correct by mistake is telling us the
          // opposite of what this correction says; the correction is the newer
          // of the two statements.
          retiredAt: null,
        },
      })

    rescheduled = true

    // No review log is written. The logs are a record of practice, and this is
    // not practice: writing one would put a review that never happened into the
    // history the scheduler reasons about.
  })

  return { ok: true, outcome: input.outcome, rescheduled }
}
