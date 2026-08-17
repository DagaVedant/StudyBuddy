import { inArray } from 'drizzle-orm'

import { attempts, reviewCards } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'

export interface Partitioned<T> {
  removable: T[]
  held: T[]
}

export async function partitionByDeletability<T extends { id: string }>(
  db: Db,
  rows: T[],
): Promise<Partitioned<T>> {
  const removableIds = new Set(
    await deletableQuestionIds(
      db,
      rows.map((row) => row.id),
    ),
  )

  return {
    removable: rows.filter((row) => removableIds.has(row.id)),
    held: rows.filter((row) => !removableIds.has(row.id)),
  }
}

export async function deletableQuestionIds(db: Db, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return []

  const [claimedByAttempt, claimedByCard] = await Promise.all([
    db
      .select({ id: attempts.questionId })
      .from(attempts)
      .where(inArray(attempts.questionId, ids)),
    db
      .select({ id: reviewCards.questionId })
      .from(reviewCards)
      .where(inArray(reviewCards.questionId, ids)),
  ])

  const claimed = new Set([
    ...claimedByAttempt.map((row) => row.id),
    ...claimedByCard.map((row) => row.id),
  ])

  return ids.filter((id) => !claimed.has(id))
}
