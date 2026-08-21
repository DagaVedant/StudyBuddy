import {and, asc, eq, inArray, isNotNull, ne, notInArray, sql} from 'drizzle-orm'

import {type BBox, answerChoices, attempts, questions, topics, worksheetPages, worksheets} from '@/lib/schema'
import {type Db} from '@/lib/db'

export const IS_QUESTION = sql`(
  ${questions.promptText} ~ '([a-z]{3,}.*){3}'
  or ${questions.promptText} ~ '[=<>+*/×÷≤≥−]|[0-9]+[[:space:]]*[-][[:space:]]*[0-9]+'
)`

export const CHOICE_ORDER = [asc(answerChoices.label), asc(answerChoices.id)]

export const COUNTS_TOWARDS_ACCURACY = sql`exists (
  select 1 from ${questions} scored
  where scored.id = ${attempts.questionId} and scored.origin = 'extracted'
)`

export interface LoadedChoice {
  id: string
  label: string
  text: string
  isCorrect: boolean
}

export interface LoadedQuestion {
  id: string
  ordinal: number
  printedNumber: number | null
  promptText: string
  questionType: string
  bbox: BBox | null
  
  top: number | null
  contentHash: string | null
  userVerified: boolean
  pageId: string | null
  pageNumber: number | null
  choices: LoadedChoice[]
}

export async function loadQuestionsWithChoices(
  db: Db,
  worksheetId: string,
): Promise<LoadedQuestion[]> {
  const rows = await db
    .select({
      id: questions.id,
      ordinal: questions.ordinal,
      printedNumber: questions.printedNumber,
      promptText: questions.promptText,
      questionType: questions.questionType,
      bbox: questions.bbox,
      contentHash: questions.contentHash,
      userVerified: questions.userVerified,
      pageId: questions.pageId,
      pageNumber: worksheetPages.pageNumber,
    })
    .from(questions)
    .leftJoin(worksheetPages, eq(worksheetPages.id, questions.pageId))
    .where(eq(questions.worksheetId, worksheetId))
    .orderBy(asc(questions.ordinal))

  if (rows.length === 0) return []

  const choiceRows = await db
    .select({
      id: answerChoices.id,
      questionId: answerChoices.questionId,
      label: answerChoices.label,
      text: answerChoices.text,
      isCorrect: answerChoices.isCorrect,
    })
    .from(answerChoices)
    .where(
      inArray(
        answerChoices.questionId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(...CHOICE_ORDER)

  const choicesFor = new Map<string, LoadedChoice[]>()
  for (const choice of choiceRows) {
    const list = choicesFor.get(choice.questionId)
    const entry = {
      id: choice.id,
      label: choice.label,
      text: choice.text,
      isCorrect: choice.isCorrect,
    }
    if (list) list.push(entry)
    else choicesFor.set(choice.questionId, [entry])
  }

  return rows.map((row) => ({
    ...row,
    top: Array.isArray(row.bbox) ? row.bbox[1] : null,
    choices: choicesFor.get(row.id) ?? [],
  }))
}

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

export interface ReferenceCheck {
  ok: boolean
  field?: 'pageId' | 'topicId'
}

export async function checkReferences(
  db: Db,
  worksheetId: string,
  input: {pageId?: string | null; topicId?: string | null},
): Promise<ReferenceCheck> {
  if (input.pageId) {
    const [page] = await db
      .select({id: worksheetPages.id})
      .from(worksheetPages)
      .where(
        and(
          eq(worksheetPages.id, input.pageId),
          eq(worksheetPages.worksheetId, worksheetId),
        ),
      )
      .limit(1)

    if (!page) return {ok: false, field: 'pageId'}
  }

  if (input.topicId) {
    const [topic] = await db
      .select({id: topics.id})
      .from(topics)
      .where(eq(topics.id, input.topicId))
      .limit(1)

    if (!topic) return {ok: false, field: 'topicId'}
  }

  return {ok: true}
}

export function referenceError(field: 'pageId' | 'topicId'): string {
  return field === 'pageId'
    ? 'That page is not part of this worksheet.'
    : 'That topic no longer exists. Pick another one.'
}

export async function verifyRemaining(
  db: Db,
  worksheetId: string,
  exclude: string[] = [],
): Promise<string[]> {
  const updated = await db
    .update(questions)
    .set({userVerified: true})
    .where(
      and(
        eq(questions.worksheetId, worksheetId),
        eq(questions.userVerified, false),
        exclude.length > 0 ? notInArray(questions.id, exclude) : undefined,
      ),
    )
    .returning({id: questions.id})

  return updated.map((row) => row.id)
}

export async function unverifyQuestions(
  db: Db,
  worksheetId: string,
  ids: string[],
): Promise<string[]> {
  const updated = await db
    .update(questions)
    .set({userVerified: false})
    .where(and(eq(questions.worksheetId, worksheetId), inArray(questions.id, ids)))
    .returning({id: questions.id})

  return updated.map((row) => row.id)
}
