import {NextResponse} from 'next/server'
import {and, eq, inArray, sql} from 'drizzle-orm'
import {z} from 'zod'
import {answerChoices, attempts, questions, reviewCards, reviewLogs} from '@/lib/schema'
import {guardWorksheet} from '@/lib/queue'
import {guardRateLimit, WORKSHEET_WRITE_LIMIT} from '@/lib/api'
import {correctMarkupAttempt, scheduleFromOutcome, type StoredCard} from '@/lib/review'
import {db} from '@/lib/db'

const markSchema = z.object({
  marks: z
    .array(
      z.object({
        questionId: z.string().min(1),
        outcome: z.enum(['correct', 'unsure', 'wrong']),
        selectedChoiceId: z.string().min(1).nullish(),
        freeTextAnswer: z.string().trim().max(2000).nullish(),
      }),
    )
    .min(1)
    .max(500),
})

const correctionSchema = z.object({
  questionId: z.string().min(1),
  outcome: z.enum(['correct', 'unsure', 'wrong']),
  selectedChoiceId: z.string().min(1).nullish(),
  freeTextAnswer: z.string().trim().max(2000).nullish(),
})

async function patchIdAttempts(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {id: worksheetId} = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({error: 'Not found'}, {status: guard.status})
  }

  const parsed = correctionSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const limited = await guardRateLimit(
    db,
    WORKSHEET_WRITE_LIMIT,
    `user:${guard.userId}`,
    'Too many changes to your worksheets. Try again shortly.',
  )
  if (limited) return limited

  const result = await correctMarkupAttempt(db, guard.userId, worksheetId, parsed.data)

  if (!result.ok) {
    return NextResponse.json(
      {
        error:
          result.reason === 'not-marked'
            ? 'This question has not been marked yet'
            : 'No matching question',
      },
      {status: 404},
    )
  }

  return NextResponse.json({ok: true, outcome: result.outcome})
}

async function postIdAttempts(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {id: worksheetId} = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({error: 'Not found'}, {status: guard.status})
  }

  const parsed = markSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const limited = await guardRateLimit(
    db,
    WORKSHEET_WRITE_LIMIT,
    `user:${guard.userId}`,
    'Too many changes to your worksheets. Try again shortly.',
  )
  if (limited) return limited

  const {marks} = parsed.data
  const questionIds = marks.map((mark) => mark.questionId)

  const owned = await db
    .select({id: questions.id})
    .from(questions)
    .where(
      and(
        eq(questions.worksheetId, worksheetId),
        inArray(questions.id, questionIds),
      ),
    )

  const ownedIds = new Set(owned.map((row) => row.id))
  const accepted = marks.filter((mark) => ownedIds.has(mark.questionId))

  if (accepted.length === 0) {
    return NextResponse.json({error: 'No matching questions'}, {status: 400})
  }

  const [already] = await db
    .select({id: attempts.id})
    .from(attempts)
    .innerJoin(questions, eq(questions.id, attempts.questionId))
    .where(
      and(
        eq(questions.worksheetId, worksheetId),
        eq(attempts.userId, guard.userId),
        eq(attempts.source, 'markup'),
      ),
    )
    .limit(1)

  if (already) {
    return NextResponse.json(
      {error: 'This worksheet was already marked', next: '/dashboard'},
      {status: 409},
    )
  }

  const validChoices = await db
    .select({id: answerChoices.id, questionId: answerChoices.questionId})
    .from(answerChoices)
    .where(inArray(answerChoices.questionId, [...ownedIds]))

  const choiceOwner = new Map(validChoices.map((row) => [row.id, row.questionId]))
  const now = new Date()

  await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(reviewCards)
      .where(
        and(
          eq(reviewCards.userId, guard.userId),
          inArray(reviewCards.questionId, [...ownedIds]),
        ),
      )

    const cardByQuestion = new Map(existing.map((card) => [card.questionId, card]))

    const scheduled = accepted.map((mark) => {
      const current = cardByQuestion.get(mark.questionId)
      const stored: StoredCard | null = current
        ? {
            dueAt: current.dueAt,
            stability: current.stability,
            difficulty: current.difficulty,
            elapsedDays: current.elapsedDays,
            scheduledDays: current.scheduledDays,
            learningSteps: current.learningSteps,
            reps: current.reps,
            lapses: current.lapses,
            state: current.state,
            lastReview: current.lastReview,
          }
        : null

      return {mark, ...scheduleFromOutcome(stored, mark.outcome, now)}
    })

    await tx
      .insert(attempts)
      .values(
        accepted.map((mark) => ({
          userId: guard.userId,
          questionId: mark.questionId,
          outcome: mark.outcome,
          selectedChoiceId:
            mark.selectedChoiceId &&
            choiceOwner.get(mark.selectedChoiceId) === mark.questionId
              ? mark.selectedChoiceId
              : null,
          freeTextAnswer: mark.freeTextAnswer ?? null,
          source: 'markup' as const,
        })),
      )
      .onConflictDoNothing()

    const saved = await tx
      .insert(reviewCards)
      .values(
        scheduled.map(({mark, card}) => ({
          userId: guard.userId,
          questionId: mark.questionId,
          ...card,
        })),
      )
      .onConflictDoUpdate({
        target: [reviewCards.userId, reviewCards.questionId],
        set: {
          dueAt: sql`excluded.due_at`,
          stability: sql`excluded.stability`,
          difficulty: sql`excluded.difficulty`,
          elapsedDays: sql`excluded.elapsed_days`,
          scheduledDays: sql`excluded.scheduled_days`,
          learningSteps: sql`excluded.learning_steps`,
          reps: sql`excluded.reps`,
          lapses: sql`excluded.lapses`,
          state: sql`excluded.state`,
          lastReview: sql`excluded.last_review`,
        },
      })
      .returning({id: reviewCards.id, questionId: reviewCards.questionId})

    const cardIdByQuestion = new Map(saved.map((row) => [row.questionId, row.id]))

    const logs = scheduled
      .map(({mark, log}) => {
        const cardId = cardIdByQuestion.get(mark.questionId)
        if (!cardId) return null
        return {
          cardId,
          rating: log.rating,
          state: log.state,
          elapsedDays: log.elapsedDays,
          scheduledDays: log.scheduledDays,
        }
      })
      .filter((row) => row !== null)

    if (logs.length > 0) await tx.insert(reviewLogs).values(logs)
  })

  return NextResponse.json({ok: true, recorded: accepted.length, next: '/dashboard'})
}

export {patchIdAttempts as PATCH}

export {postIdAttempts as POST}
