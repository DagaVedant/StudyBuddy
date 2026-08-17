import { and, eq, isNotNull, ne, sql } from 'drizzle-orm'

import type { Db } from '@/lib/db/types'
import { questions, worksheets } from '@/lib/db/schema'

const NEAR_DISTANCE = 0.06

export interface LibraryDuplicate {
  questionId: string
  matchQuestionId: string
  matchWorksheetId: string
  matchWorksheetTitle: string
  exact: boolean
}

export async function findLibraryDuplicates(
  db: Db,
  userId: string,
  worksheetId: string,
): Promise<LibraryDuplicate[]> {
  const mine = await db
    .select({
      id: questions.id,
      contentHash: questions.contentHash,
      embedding: questions.embedding,
    })
    .from(questions)
    .where(eq(questions.worksheetId, worksheetId))

  if (mine.length === 0) return []

  const found = new Map<string, LibraryDuplicate>()

  const hashes = mine
    .map((row) => row.contentHash)
    .filter((hash): hash is string => Boolean(hash))

  if (hashes.length > 0) {
    const exact = await db
      .select({
        contentHash: questions.contentHash,
        matchQuestionId: questions.id,
        matchWorksheetId: questions.worksheetId,
        matchWorksheetTitle: worksheets.title,
      })
      .from(questions)
      .innerJoin(worksheets, eq(worksheets.id, questions.worksheetId))
      .where(
        and(
          eq(questions.userId, userId),
          ne(questions.worksheetId, worksheetId),
          sql`${questions.contentHash} in ${hashes}`,
        ),
      )

    const byHash = new Map(exact.map((row) => [row.contentHash, row]))

    for (const row of mine) {
      const match = row.contentHash ? byHash.get(row.contentHash) : undefined
      if (!match) continue

      found.set(row.id, {
        questionId: row.id,
        matchQuestionId: match.matchQuestionId,
        matchWorksheetId: match.matchWorksheetId,
        matchWorksheetTitle: match.matchWorksheetTitle,
        exact: true,
      })
    }
  }

  for (const row of mine) {
    if (found.has(row.id) || !row.embedding) continue

    const literal = `[${row.embedding.join(',')}]`

    const [match] = await db
      .select({
        matchQuestionId: questions.id,
        matchWorksheetId: questions.worksheetId,
        matchWorksheetTitle: worksheets.title,
        distance: sql<number>`${questions.embedding} <=> ${literal}::vector`,
      })
      .from(questions)
      .innerJoin(worksheets, eq(worksheets.id, questions.worksheetId))
      .where(
        and(
          eq(questions.userId, userId),
          ne(questions.worksheetId, worksheetId),
          isNotNull(questions.embedding),
        ),
      )
      .orderBy(sql`${questions.embedding} <=> ${literal}::vector`)
      .limit(1)

    if (!match || Number(match.distance) > NEAR_DISTANCE) continue

    found.set(row.id, {
      questionId: row.id,
      matchQuestionId: match.matchQuestionId,
      matchWorksheetId: match.matchWorksheetId,
      matchWorksheetTitle: match.matchWorksheetTitle,
      exact: false,
    })
  }

  return [...found.values()]
}
