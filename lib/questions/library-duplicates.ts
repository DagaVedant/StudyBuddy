import { and, eq, isNotNull, ne, sql } from 'drizzle-orm'

import type { Db } from '@/lib/db/types'
import { questions, worksheets } from '@/lib/db/schema'

/**
 * How alike two questions have to be before we mention it.
 *
 * pgvector's `<=>` under `vector_cosine_ops` is cosine *distance*, so this is
 * a similarity of 0.94. Deliberately high: the two rows being compared are
 * usually the same question off the same practice book, where the only
 * difference is what the reader made of a fraction, and that barely moves the
 * vector. Ordinary same-topic questions ("find angle C" against "find angle
 * B") sit far below it, and a threshold loose enough to catch those would put
 * a duplicate warning on half the paper.
 */
const NEAR_DISTANCE = 0.06

export interface LibraryDuplicate {
  /** The question on the worksheet being checked. */
  questionId: string
  /** The question already in the student's library. */
  matchQuestionId: string
  matchWorksheetId: string
  matchWorksheetTitle: string
  /** True when the content hashes agree, so the two read identically. */
  exact: boolean
}

/**
 * Questions on this worksheet the student already has from a different one.
 *
 * Spec §6.3, and the reason `questions.embedding`, `questions_embedding_idx`
 * and `questions_content_hash_idx` exist. Both halves are scoped to one user:
 * practice books repeat themselves, but one student's library is no evidence
 * about another's, and the indexes lead with `user_id` for that reason.
 *
 * Nothing here merges anything. The spec is explicit that a near match is
 * offered during extraction review and never applied silently, because the
 * cost of being wrong is a question the student never sees again.
 */
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

  // Exact first, so a question matched both ways is reported as the stronger
  // of the two. The embedding pass below will not overwrite it.
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

  // One nearest-neighbour lookup per remaining question. The HNSW index makes
  // each one cheap, and a worksheet only reaches this page once.
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
