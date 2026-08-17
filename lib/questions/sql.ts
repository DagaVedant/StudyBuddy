import { asc, sql } from 'drizzle-orm'

import { answerChoices, questions } from '@/lib/db/schema'

export const IS_QUESTION = sql`(
  ${questions.promptText} ~ '([a-z]{3,}.*){3}'
  or ${questions.promptText} ~ '[=<>+*/×÷≤≥−]|[0-9]+[[:space:]]*[-][[:space:]]*[0-9]+'
)`

export const CHOICE_ORDER = [asc(answerChoices.label), asc(answerChoices.id)]
