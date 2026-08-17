import { and, eq, inArray, notInArray } from 'drizzle-orm'

import { questions } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'

export async function verifyRemaining(
  db: Db,
  worksheetId: string,
  exclude: string[] = [],
): Promise<string[]> {
  const updated = await db
    .update(questions)
    .set({ userVerified: true })
    .where(
      and(
        eq(questions.worksheetId, worksheetId),
        eq(questions.userVerified, false),
        exclude.length > 0 ? notInArray(questions.id, exclude) : undefined,
      ),
    )
    .returning({ id: questions.id })

  return updated.map((row) => row.id)
}

export async function unverifyQuestions(
  db: Db,
  worksheetId: string,
  ids: string[],
): Promise<string[]> {
  const updated = await db
    .update(questions)
    .set({ userVerified: false })
    .where(and(eq(questions.worksheetId, worksheetId), inArray(questions.id, ids)))
    .returning({ id: questions.id })

  return updated.map((row) => row.id)
}
