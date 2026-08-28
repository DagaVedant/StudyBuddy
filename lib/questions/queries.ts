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

export type LoadedChoice = {
  id: string
  label: string
  text: string
  isCorrect: boolean
}

export type LoadedQuestion = {
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

export async function loadQuestionsWithChoices(db: Db, worksheetId: string) {
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

  const ids: string[] = []
  for (const row of rows) ids.push(row.id)

  const choiceRows = await db
    .select({
      id: answerChoices.id,
      questionId: answerChoices.questionId,
      label: answerChoices.label,
      text: answerChoices.text,
      isCorrect: answerChoices.isCorrect,
    })
    .from(answerChoices)
    .where(inArray(answerChoices.questionId, ids))
    .orderBy(...CHOICE_ORDER)

  const choicesFor = new Map<string, LoadedChoice[]>()

  for (const choice of choiceRows) {
    const entry = {
      id: choice.id,
      label: choice.label,
      text: choice.text,
      isCorrect: choice.isCorrect,
    }

    const list = choicesFor.get(choice.questionId)
    if (list) list.push(entry)
    else choicesFor.set(choice.questionId, [entry])
  }

  const loaded: LoadedQuestion[] = []

  for (const row of rows) {
    let top = null
    if (Array.isArray(row.bbox)) top = row.bbox[1]

    let choices = choicesFor.get(row.id)
    if (!choices) choices = []

    loaded.push({
      id: row.id,
      ordinal: row.ordinal,
      printedNumber: row.printedNumber,
      promptText: row.promptText,
      questionType: row.questionType,
      bbox: row.bbox,
      top: top,
      contentHash: row.contentHash,
      userVerified: row.userVerified,
      pageId: row.pageId,
      pageNumber: row.pageNumber,
      choices: choices,
    })
  }

  return loaded
}

const NEAR_DISTANCE = 0.06

export type LibraryDuplicate = {
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

  const hashes: string[] = []
  for (const row of mine) {
    if (row.contentHash) hashes.push(row.contentHash)
  }

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

    const byHash = new Map<string, (typeof exact)[number]>()
    for (const row of exact) {
      if (row.contentHash) byHash.set(row.contentHash, row)
    }

    for (const row of mine) {
      if (!row.contentHash) continue

      const match = byHash.get(row.contentHash)
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

    const literal = '[' + row.embedding.join(',') + ']'

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

  const duplicates: LibraryDuplicate[] = []
  for (const duplicate of found.values()) duplicates.push(duplicate)

  return duplicates
}

export type ReferenceCheck = {
  ok: boolean
  field: string
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

  return {ok: true, field: ''}
}

export function referenceError(field: string) {
  if (field === 'pageId') return 'That page is not part of this worksheet.'

  return 'That topic no longer exists. Pick another one.'
}

export async function verifyRemaining(
  db: Db,
  worksheetId: string,
  exclude: string[] = [],
) {
  let notExcluded = undefined
  if (exclude.length > 0) notExcluded = notInArray(questions.id, exclude)

  const updated = await db
    .update(questions)
    .set({userVerified: true})
    .where(
      and(
        eq(questions.worksheetId, worksheetId),
        eq(questions.userVerified, false),
        notExcluded,
      ),
    )
    .returning({id: questions.id})

  const ids: string[] = []
  for (const row of updated) ids.push(row.id)

  return ids
}

export async function unverifyQuestions(db: Db, worksheetId: string, ids: string[]) {
  const updated = await db
    .update(questions)
    .set({userVerified: false})
    .where(and(eq(questions.worksheetId, worksheetId), inArray(questions.id, ids)))
    .returning({id: questions.id})

  const changed: string[] = []
  for (const row of updated) changed.push(row.id)

  return changed
}
