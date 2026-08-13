import { and, asc, eq, notExists, sql } from 'drizzle-orm'

import type { AIProvider } from '@/lib/ai/types'
import { answerChoices, questionSolutions, questions } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'
import { CHOICE_ORDER } from '@/lib/questions/choice-order'
import { normalizeChoiceLabel } from '@/lib/questions/shape'

/**
 * Below this, the answer is recorded but not promoted to the question.
 *
 * The model is told to return null rather than guess, and mostly does. This
 * catches the other case: an answer offered with visible doubt. The working is
 * still worth keeping, since a student reading the steps can see where it went
 * uncertain, but it does not become the answer the paper is marked against.
 *
 * 0.6 rather than 0.5 because half the mass of a hedging model sits at exactly
 * 0.5, and a threshold that admits the median hedge is not a threshold.
 */
const PROMOTE_ABOVE = 0.6

export interface SolutionProgress {
  solved: number
  promoted: number
  refused: number
  failed: number
}

/**
 * Works out every question on a worksheet that has no solution yet.
 *
 * Resumable by construction: the loop reads the questions that have no
 * `question_solutions` row rather than counting through a list, so a job that
 * dies at question 80 of 114 picks up at 80 and not at 1. On a paper this size
 * that is the difference between a retry costing four minutes and forty.
 *
 * Promotion is the careful part. A key printed on the paper or typed by the
 * student always wins: this only fills `correct_answer` where nothing had one,
 * and stamps `answer_source = 'ai_derived'` when it does, so the review screen
 * can badge it and a reader can tell what the paper said from what a model
 * worked out. It never overwrites, never downgrades a `pdf_key`, and never
 * promotes an answer the model was unsure of.
 */
export async function deriveSolutions(
  db: Db,
  provider: AIProvider,
  worksheetId: string,
  options: {
    limit?: number
    onProgress?: (done: number, total: number) => Promise<void> | void
    log?: ((message: string) => void) | null
  } = {},
): Promise<SolutionProgress> {
  const log = options.log === undefined ? console.log : options.log
  const progress: SolutionProgress = { solved: 0, promoted: 0, refused: 0, failed: 0 }

  const pending = await db
    .select({
      id: questions.id,
      promptText: questions.promptText,
      answerSource: questions.answerSource,
    })
    .from(questions)
    .where(
      and(
        eq(questions.worksheetId, worksheetId),
        notExists(
          db
            .select({ one: sql`1` })
            .from(questionSolutions)
            .where(eq(questionSolutions.questionId, questions.id)),
        ),
      ),
    )
    .orderBy(asc(questions.ordinal), asc(questions.id))
    .limit(options.limit ?? 500)

  if (pending.length === 0) return progress

  for (const [index, question] of pending.entries()) {
    // Read per question rather than joined into the query above, because the
    // order matters: the label the model returns is compared against these, and
    // CHOICE_ORDER is the same ordering every other reader of this table uses.
    const choices = await db
      .select({ label: answerChoices.label, text: answerChoices.text })
      .from(answerChoices)
      .where(eq(answerChoices.questionId, question.id))
      .orderBy(...CHOICE_ORDER)

    try {
      const solution = await provider.answerQuestion({
        promptText: question.promptText,
        choices,
      })

      await db
        .insert(questionSolutions)
        .values({
          questionId: question.id,
          derivedAnswer: solution.answer,
          workingMd: solution.working,
          traps: solution.traps,
          confidence: solution.confidence,
          provider: storedProviderName(provider.name),
          model: provider.answeringModel,
        })
        // A retry that raced the row it was about to write is not a failure,
        // and the question is unique here.
        .onConflictDoNothing({ target: questionSolutions.questionId })

      if (solution.answer === null) {
        progress.refused += 1
      } else {
        progress.solved += 1

        const promoted = await promoteDerivedAnswer(db, {
          questionId: question.id,
          answer: solution.answer,
          confidence: solution.confidence,
          choices,
          answerSource: question.answerSource,
        })
        if (promoted) progress.promoted += 1
      }
    } catch (error) {
      // One question failing is survivable and the rest of the paper is still
      // worth working out. The row is simply absent, so a later run retries it.
      progress.failed += 1
      log?.(
        `[solutions] question ${question.id} could not be solved: ${(error as Error).message}`,
      )
    }

    await options.onProgress?.(index + 1, pending.length)
  }

  log?.(
    `[solutions] ${worksheetId}: ${progress.solved} solved, ${progress.promoted} promoted, ` +
      `${progress.refused} declined, ${progress.failed} failed`,
  )

  return progress
}

/**
 * Fills in an answer only where the question had none.
 *
 * Exported because two paths reach it: the server-side pass below, and the
 * worker posting one solution at a time over HTTP. The never-overwrite rule is
 * the whole point of this feature being safe, so it lives in one function
 * rather than in two that have to agree.
 *
 * Returns whether it wrote. The `answer_source = 'none'` in the WHERE is not
 * belt and braces over the check above it: the row is re-read here inside the
 * update, so a key applied by another pass between the select and now still
 * wins the race.
 */
export async function promoteDerivedAnswer(
  db: Db,
  input: {
    questionId: string
    answer: string | null
    confidence: number
    choices: { label: string; text: string }[]
    answerSource: string
  },
): Promise<boolean> {
  const { questionId, answer, confidence, choices, answerSource } = input

  if (answer === null) return false
  if (answerSource !== 'none') return false
  if (confidence < PROMOTE_ABOVE) return false

  const stored = storedAnswer(answer, choices)
  if (!stored) return false

  const updated = await db
    .update(questions)
    .set({ correctAnswer: stored, answerSource: 'ai_derived' })
    .where(and(eq(questions.id, questionId), eq(questions.answerSource, 'none')))
    .returning({ id: questions.id })

  return updated.length > 0
}

/**
 * The answer in the form the rest of the app stores.
 *
 * A multiple-choice answer is the label and nothing else, because that is what
 * markup compares against and what the Blooket export writes. A model that
 * answered with the option's text instead is right about the question and wrong
 * about the format, so it is matched back rather than discarded.
 *
 * Anything that matches no option on a question that has options is refused. On
 * a paper where every choice is "4", "6", "9", "12", a free-text answer of "6"
 * is ambiguous between being the label and being the value, and guessing wrong
 * marks a student down on a question they got right.
 */
export function storedAnswer(
  answer: string,
  choices: { label: string; text: string }[],
): string | null {
  const trimmed = answer.trim()
  if (!trimmed) return null

  if (choices.length === 0) return trimmed.slice(0, 200)

  // Compared without case but returned with the stored label's own case.
  // `normalizeChoiceLabel` preserves case deliberately, because extraction
  // keeps whatever the paper printed, so a model answering "b" against a paper
  // printing "B" is agreeing rather than disagreeing. What goes back has to be
  // the label as stored, since that is what markup compares against.
  const label = normalizeChoiceLabel(trimmed).toLowerCase()
  const byLabel = choices.find((choice) => choice.label.toLowerCase() === label)
  if (byLabel) return byLabel.label

  const byText = choices.find(
    (choice) => choice.text.trim().toLowerCase() === trimmed.toLowerCase(),
  )
  return byText ? byText.label : null
}

/** The provider column is an enum; the mock and null providers are not in it. */
function storedProviderName(
  name: string,
): 'anthropic' | 'openai' | 'openrouter' | 'google' | 'ollama' | null {
  switch (name) {
    case 'anthropic':
    case 'openai':
    case 'openrouter':
    case 'google':
    case 'ollama':
      return name
    default:
      return null
  }
}
