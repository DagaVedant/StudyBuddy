import {and, asc, eq, inArray, notExists, sql} from 'drizzle-orm'

import {answerChoices, questions, questionSolutions} from '@/lib/schema'
import {type AIProvider} from '@/lib/ai/types'
import {CHOICE_ORDER} from '@/lib/questions/queries'
import {normalizeChoiceLabel} from '@/lib/questions/shape'
import {type Db} from '@/lib/db'

const PROMOTE_ABOVE = 0.6

const ANSWER_BATCH = 10

function storedProviderName(name: string) {
  if (name === 'anthropic') return 'anthropic'
  if (name === 'openai') return 'openai'
  if (name === 'openrouter') return 'openrouter'
  if (name === 'google') return 'google'
  if (name === 'ollama') return 'ollama'

  return null
}

function storedAnswer(answer: string, choices: {label: string; text: string}[]) {
  const trimmed = answer.trim()
  if (!trimmed) return null

  if (choices.length === 0) return trimmed.slice(0, 200)

  const label = normalizeChoiceLabel(trimmed).toLowerCase()

  for (const choice of choices) {
    if (choice.label.toLowerCase() === label) return choice.label
  }

  const wanted = trimmed.toLowerCase()

  for (const choice of choices) {
    if (choice.text.trim().toLowerCase() === wanted) return choice.label
  }

  return null
}

export async function promoteDerivedAnswer(
  db: Db,
  input: {
    questionId: string
    answer: string | null
    confidence: number
    choices: {label: string; text: string}[]
    answerSource: string
  },
) {
  if (input.answer === null) return false
  if (input.answerSource !== 'none') return false
  if (input.confidence < PROMOTE_ABOVE) return false

  const stored = storedAnswer(input.answer, input.choices)
  if (!stored) return false

  const updated = await db
    .update(questions)
    .set({correctAnswer: stored, answerSource: 'ai_derived'})
    .where(and(eq(questions.id, input.questionId), eq(questions.answerSource, 'none')))
    .returning({id: questions.id})

  return updated.length > 0
}

export type SolutionProgress = {
  solved: number
  promoted: number
  refused: number
  failed: number
}

export async function deriveSolutions(
  db: Db,
  provider: AIProvider,
  worksheetId: string,
  limit = 500,
): Promise<SolutionProgress> {
  const progress: SolutionProgress = {solved: 0, promoted: 0, refused: 0, failed: 0}

  const pending = await db
    .select({
      id: questions.id,
      ordinal: questions.ordinal,
      promptText: questions.promptText,
      answerSource: questions.answerSource,
    })
    .from(questions)
    .where(
      and(
        eq(questions.worksheetId, worksheetId),
        eq(questions.answerSource, 'none'),
        notExists(
          db
            .select({one: sql`1`})
            .from(questionSolutions)
            .where(eq(questionSolutions.questionId, questions.id)),
        ),
      ),
    )
    .orderBy(asc(questions.ordinal), asc(questions.id))
    .limit(limit)

  if (pending.length === 0) return progress

  const ids: string[] = []
  for (const question of pending) ids.push(question.id)

  const choiceRows = await db
    .select({
      questionId: answerChoices.questionId,
      label: answerChoices.label,
      text: answerChoices.text,
    })
    .from(answerChoices)
    .where(inArray(answerChoices.questionId, ids))
    .orderBy(...CHOICE_ORDER)

  const choicesOf = new Map<string, {label: string; text: string}[]>()

  for (const row of choiceRows) {
    let list = choicesOf.get(row.questionId)

    if (!list) {
      list = []
      choicesOf.set(row.questionId, list)
    }

    list.push({label: row.label, text: row.text})
  }

  for (let start = 0; start < pending.length; start = start + ANSWER_BATCH) {
    const batch = pending.slice(start, start + ANSWER_BATCH)

    const byOrdinal = new Map<number, (typeof pending)[number]>()
    const inputs = []

    for (const question of batch) {
      if (byOrdinal.has(question.ordinal)) continue
      byOrdinal.set(question.ordinal, question)

      let choices = choicesOf.get(question.id)
      if (!choices) choices = []

      inputs.push({
        ordinal: question.ordinal,
        promptText: question.promptText,
        choices: choices,
      })
    }

    let solutions
    try {
      solutions = await provider.answerBatch(inputs)
    } catch (error) {
      progress.failed = progress.failed + batch.length

      console.log(
        '[solutions] a batch of ' +
          batch.length +
          ' on ' +
          worksheetId +
          ' could not be solved: ' +
          (error as Error).message,
      )
      continue
    }

    const answered = new Set<number>()

    for (const solution of solutions) {
      const question = byOrdinal.get(solution.ordinal)
      if (!question) continue
      if (answered.has(solution.ordinal)) continue

      answered.add(solution.ordinal)

      let choices = choicesOf.get(question.id)
      if (!choices) choices = []

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
        .onConflictDoNothing({target: questionSolutions.questionId})

      if (solution.answer === null) {
        progress.refused = progress.refused + 1
        continue
      }

      progress.solved = progress.solved + 1

      const promoted = await promoteDerivedAnswer(db, {
        questionId: question.id,
        answer: solution.answer,
        confidence: solution.confidence,
        choices: choices,
        answerSource: question.answerSource,
      })

      if (promoted) progress.promoted = progress.promoted + 1
    }

    const missing = byOrdinal.size - answered.size

    if (missing > 0) {
      progress.failed = progress.failed + missing

      console.log(
        '[solutions] ' +
          missing +
          ' of ' +
          byOrdinal.size +
          ' question(s) in a batch on ' +
          worksheetId +
          ' came back with no entry',
      )
    }
  }

  console.log(
    '[solutions] ' +
      worksheetId +
      ': ' +
      progress.solved +
      ' solved, ' +
      progress.promoted +
      ' promoted, ' +
      progress.refused +
      ' declined, ' +
      progress.failed +
      ' failed',
  )

  return progress
}

