/**
 * Reading the shape of a page from its text layer, with no model involved.
 *
 * "Where does the first question start on this page?" is asked by three
 * different passes for three different reasons: the carried-options recovery
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

export interface QuestionStart {
  /** The number the page prints it under. */
  number: number
  /** Offset of the start of the line it begins on. */
  at: number
  /** Offset of the first character of the question itself, past the number. */
  bodyFrom: number
}

/** Every question the page appears to start, in the order it prints them. */
export function questionStartsOn(text: string): QuestionStart[] {
  QUESTION_START.lastIndex = 0

  const starts: QuestionStart[] = []
  for (let match = QUESTION_START.exec(text); match; match = QUESTION_START.exec(text)) {
    if (!looksLikeQuestion(match[2])) continue
    starts.push({
      number: Number(match[1]),
      at: match.index,
      bodyFrom: match.index + match[0].length - match[2].length,
    })
  }

  return starts
}

/** Offset of the first real question printed on the page, or the whole page. */
export function firstQuestionAt(text: string): number {
  return questionStartsOn(text)[0]?.at ?? text.length
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
  return questionStartsOn(text).map((start) => start.number)
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

/**
 * How much of a neighbouring page to show the extractor.
 *
 * Enough to carry a stem that ran over the fold and the option block under it,
 * and no more. This is prose sent on every page of every extraction, so it is
 * paid for on all of them to help the few that need it.
 */
const SEAM_CHARS = 1200

/**
 * The end of the page before this one, for a question that ran over the fold.
 *
 * Extraction reads one page at a time and the model has never seen the page
 * before or after, so a question whose stem ends at the foot of page N and
 * whose options begin at the head of N+1 is not whole in either request. The
 * repair passes recover the common shapes of that afterwards, and refuse the
 * rest by design, because joining rows is a deletion and this codebase has been
 * bitten twice by a join rule that read correctly and was wrong on real data.
 *
 * The cheaper fix is to stop cutting the question in the first place. The
 * worker already holds every page's text when it extracts, so the two
 * neighbours cost nothing to fetch and nothing in image tokens; they were
 * simply never shown to the model.
 *
 * Trimmed to a whole line at both ends. Half a word at the seam is a word the
 * model has to guess at, and guessing is the failure this is here to remove.
 */
export function tailOf(text: string, limit = SEAM_CHARS): string {
  if (text.length <= limit) return text.trim()

  const cut = text.slice(text.length - limit)
  const firstBreak = cut.indexOf('\n')
  return (firstBreak === -1 ? cut : cut.slice(firstBreak + 1)).trim()
}

/** The start of the page after this one. See {@link tailOf}. */
export function headOf(text: string, limit = SEAM_CHARS): string {
  if (text.length <= limit) return text.trim()

  const cut = text.slice(0, limit)
  const lastBreak = cut.lastIndexOf('\n')
  return (lastBreak === -1 ? cut : cut.slice(0, lastBreak)).trim()
}

/**
 * The seam either side of one page, ready to hand to the extractor.
 *
 * Indexed against the full ordered page list rather than whatever subset a
 * caller is iterating. Pages get skipped, answer keys most often, and the page
 * a question ran onto is the one physically next to it in the document, not the
 * next one this loop happens to be extracting.
 *
 * Empty strings rather than undefined for the ends of the document: the prompt
 * builder omits a blank block, so the first and last page simply carry one
 * neighbour instead of two.
 */
export function seamAround(
  pages: readonly { ocrText?: string | null }[],
  index: number,
): { before: string; after: string } {
  return {
    before: tailOf(pages[index - 1]?.ocrText ?? ''),
    after: headOf(pages[index + 1]?.ocrText ?? ''),
  }
}
