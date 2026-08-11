import { asc } from 'drizzle-orm'

import { answerChoices } from '@/lib/db/schema'

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
