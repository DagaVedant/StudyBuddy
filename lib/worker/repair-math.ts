import { eq } from 'drizzle-orm'

import { answerChoices, questions } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'
import { loadQuestionsWithChoices } from '@/lib/questions/load'
import { normalizeMath } from '@/lib/questions/math'
import { hashQuestion } from '@/lib/questions/shape'

export async function repairUnrenderedMath(
  db: Db,
  worksheetId: string,
): Promise<{ repaired: number }> {
  const rows = await loadQuestionsWithChoices(db, worksheetId)

  if (rows.length === 0) return { repaired: 0 }

  let repaired = 0

  for (const row of rows) {
    const choices = row.choices
    const promptText = normalizeMath(row.promptText)
    const fixedChoices = choices.map((choice) => ({
      ...choice,
      fixed: normalizeMath(choice.text),
    }))

    const changedChoices = fixedChoices.filter((choice) => choice.fixed !== choice.text)
    if (promptText === row.promptText && changedChoices.length === 0) continue

    for (const choice of changedChoices) {
      await db
        .update(answerChoices)
        .set({ text: choice.fixed })
        .where(eq(answerChoices.id, choice.id))
    }

    const contentHash = hashQuestion(
      promptText,
      fixedChoices.map((choice) => ({ text: choice.fixed })),
    )

    await db
      .update(questions)
      .set({ promptText, contentHash })
      .where(eq(questions.id, row.id))

    repaired += 1
    console.log(`[maths] rewrote ${row.id} on ${worksheetId}: ${promptText.slice(0, 60)}`)
  }

  return { repaired }
}
