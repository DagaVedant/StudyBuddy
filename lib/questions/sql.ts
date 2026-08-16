/**
 * The two Drizzle fragments that describe questions in a query.
 *
 * `IS_QUESTION` is a WHERE predicate and `CHOICE_ORDER` is an ORDER BY, so they
 * are not the same kind of thing. They are together because they are the only
 * two, both are one expression long, and every screen that counts questions
 * needs the first while every screen that lists choices needs the second.
 */

import { asc, sql } from 'drizzle-orm'

import { answerChoices, questions } from '@/lib/db/schema'

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

/**
 * The order a question's options are read in, everywhere they are read.
 *
 * There is no position column: the label is the position. A, B, C, D is the
 * order they are printed on the paper, the order they are shown on screen, and
 * the order everything downstream assumes when it works with them by index.
 *
 * Postgres is under no obligation to return rows in any particular order
 * without being told, and it does not. Eight places loaded a question's options
 * and one of them said this, so the markup screen offered "B 2, C 3, D 4, A 1"
 * for a question whose paper prints A first. Three of the others are worse than
 * cosmetic:
 *
 *   - the review queue shows the options a student picks their answer from, so
 *     the order they are asked in is arbitrary per render;
 *   - the Blooket export writes the correct answer as a *position* in the list
 *     it just wrote, and trims five options to four by keeping the correct one,
 *     so which option survives depended on the order they arrived in;
 *   - the question PATCH route recomputes the content hash from the stored
 *     option text, and that hash is the dedupe identity for the whole pipeline.
 *     Two edits to one untouched question could hash it two ways, which is a
 *     silent duplicate, which has happened here twice before for other reasons.
 *
 * `id` after `label` so two options that somehow share a label still come back
 * in a stable order rather than swapping between reads.
 */
export const CHOICE_ORDER = [asc(answerChoices.label), asc(answerChoices.id)]
