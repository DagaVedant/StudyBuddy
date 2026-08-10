import { sql } from 'drizzle-orm'

import { questions } from '@/lib/db/schema'

/**
 * A stored row that is actually a question, for counting purposes.
 *
 * Not everything stored against a worksheet is a question. Page furniture and
 * figure labels get captured as rows: "CONTINUE TO THE NEXT PAGE", "FORM B",
 * the coordinate labels off a diagram. Showing 26 for a 25-question paper sent
 * a student hunting for a mistake that was ours.
 *
 * A row counts when it reads like a sentence (three runs of letters) or asks
 * for a calculation (an operator, or a subtraction between two numbers).
 * Checked against every stored question when it was written: it dropped 23
 * rows, all of them page furniture, and not one carrying a printed number.
 *
 * It is a display rule and not a delete, deliberately. The same test applied at
 * ingest rejected real questions, and it still would: "Solve for x." and "Find
 * angle C." both fail it. That is the cost of the rule, and it is why it never
 * decides what is stored, only what is counted.
 *
 * Lives here rather than beside one of the counts because there are three of
 * them across two pages, and they were not all using it. The worksheets page
 * filtered, the dashboard did not, so the same paper was 25 questions on one
 * screen and 26 on the other, with no way for a student to tell which was
 * lying. A predicate that decides a number the student reads has to be one
 * predicate.
 */
export const IS_QUESTION = sql`(
  ${questions.promptText} ~ '([a-z]{3,}.*){3}'
  or ${questions.promptText} ~ '[=<>+*/×÷≤≥−]|[0-9]+[[:space:]]*[-][[:space:]]*[0-9]+'
)`
