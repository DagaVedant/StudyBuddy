import { asc, sql } from 'drizzle-orm'

import { answerChoices, attempts, questions } from '@/lib/db/schema'

export const IS_QUESTION = sql`(
  ${questions.promptText} ~ '([a-z]{3,}.*){3}'
  or ${questions.promptText} ~ '[=<>+*/×÷≤≥−]|[0-9]+[[:space:]]*[-][[:space:]]*[0-9]+'
)`

export const CHOICE_ORDER = [asc(answerChoices.label), asc(answerChoices.id)]

export const COUNTS_TOWARDS_ACCURACY = sql`exists (
  select 1 from ${questions} scored
  where scored.id = ${attempts.questionId} and scored.origin = 'extracted'
)`
