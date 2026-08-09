/**
 * Reading the shape of a page from its text layer, with no model involved.
 *
 * "Where does the first question start on this page?" is asked by three
 * different passes for three different reasons — the carried-options recovery
 * wants the room above it, the answer-key detector wants to know whether a key
 * page has any real questions above the key, and the coverage audit wants to
 * know whether a page that produced nothing had anything on it to produce.
 * They have to agree, because two of them disagreeing means one pass skips a
 * page the other one was relying on it to read.
 */

/**
 * A question beginning on this page: a printed number, then the start of a
 * sentence.
 *
 * Deliberately demands prose after the number. Papers are full of lines like
 * "5 2 6 5" and "8 14 10" (distances written along a diagram) and treating
 * one of those as the first question would hide a genuine carried-over block
 * behind it.
 */
const QUESTION_START = /^[ \t]*\(?(\d{1,3})[.)]?[ \t]+(?=[A-Z(])(.{12,})$/gm
const PROSE = /[a-z]{3,}/g

/** Three or more ordinary words is enough to call something a sentence. */
function looksLikeQuestion(line: string): boolean {
  return (line.match(PROSE) ?? []).length >= 3
}

/** Offset of the first real question printed on the page, or the whole page. */
export function firstQuestionAt(text: string): number {
  QUESTION_START.lastIndex = 0

  for (let match = QUESTION_START.exec(text); match; match = QUESTION_START.exec(text)) {
    if (looksLikeQuestion(match[2])) return match.index
  }

  return text.length
}

/**
 * The numbers the page appears to print its questions under.
 *
 * A heuristic, and known to be one: measured against fourteen stored sheets it
 * agrees exactly with what was extracted on 35 of 47 question pages, running
 * both over and under. Good enough to say *where* on a paper something went
 * missing, and not good enough to say how many questions a page has. Use the
 * paper's own answer key for that.
 */
export function questionNumbersOn(text: string): number[] {
  QUESTION_START.lastIndex = 0

  const numbers: number[] = []
  for (let match = QUESTION_START.exec(text); match; match = QUESTION_START.exec(text)) {
    if (looksLikeQuestion(match[2])) numbers.push(Number(match[1]))
  }

  return numbers
}

/**
 * How many numbered questions the page's text appears to print.
 *
 * Used to tell "this page produced nothing because there was nothing on it"
 * from "this page produced nothing and it should have", which the audit could
 * not distinguish and so treated both as fine. That is a question the count
 * answers reliably even though the count itself is approximate: on all 47
 * question pages of the Edison run it is non-zero, and on all 35 key,
 * solutions and cover pages it is zero.
 */
export function countQuestionStarts(text: string): number {
  return questionNumbersOn(text).length
}
