/**
 * Reads a page's questions and their options straight out of the text layer.
 *
 * Not a replacement for extraction, which has to cope with figures, passages,
 * multi-part questions and papers whose layout is a surprise. This is the
 * narrow case: a paper that prints `N. <stem>` followed by one option per line,
 * where the options are sitting in the text and something else lost them.
 *
 * Forty-nine questions across the Edison run are stored with no options at all,
 * not because extraction missed them but because a PATCH route deleted them
 * when the student confirmed the question had been read correctly. The text was
 * never wrong, so re-reading it needs no model and cannot introduce anything
 * the page does not say.
 *
 * Options must be at the start of a line. Papers that run them inline, like
 * AMC's `(A) 28 (B) 29 (C) 30`, come back with no options rather than a guess:
 * the inline form is what a stem full of ordinary sentences looks like to a
 * loose reading, and a wrong option is worse than a visibly missing one.
 */
import { normalizeMath } from './math'

export interface PageOption {
  label: string
  text: string
}

export interface PageQuestion {
  number: number
  stem: string
  /** Empty when the page does not print a clean run of them for this question. */
  options: PageOption[]
}

/**
 * A line opening with a printed number.
 *
 * Deliberately looser than the question-start pattern in page-text.ts, which
 * demands prose after the number so that a figure's "5 2 6 5" is not mistaken
 * for a question. That strictness is right when the job is to guess which
 * numbers a page holds, and wrong here, for two reasons. It misses real
 * questions that open with a numeral or a currency symbol ("11. 60 is what
 * percent of 40?", "13. $1,000 is invested at 10% annual interest"), and worse,
 * a missed question does not end the block above it: the previous question's
 * last option swallowed the whole of the next stem.
 *
 * Every use of this is checked against a question that is already stored under
 * that number, and against the stored prompt, so a block that is really a
 * figure label matches nothing and is dropped.
 */
const NUMBERED_LINE = /^[ \t]*\(?(\d{1,3})[.)][ \t]+(.*)$/gm

/** An option on its own line: "A. 0%", "(B) -20%", "c) 45". */
const OPTION_LINE = /^[ \t]*\(?([A-Za-z])[).][ \t]+(.*)$/gm

/** Longest an option's text may run before it stops looking like an option. */
const MAX_OPTION_TEXT = 300

const A = 'A'.charCodeAt(0)

/** Whether an option's text has the next option's label buried inside it. */
function nextLabelInside(body: string, code: number): boolean {
  if (code > 'Z'.charCodeAt(0)) return false

  const label = String.fromCharCode(code)
  return new RegExp(`(?<![\\p{L}\\p{N}])\\(?[${label}${label.toLowerCase()}][).][ \\t]`, 'u').test(
    body,
  )
}

/**
 * Every numbered block the page prints, with whatever options are under each.
 *
 * A block runs from its own number to the next one, so the last block on a page
 * runs to the end of the text. That is also where a page break falls: the last
 * question on a page routinely keeps only `A`, with the rest printed at the top
 * of the next page. Those come back as a short run rather than being dropped,
 * because a stem holding `A` is exactly what parseCarriedChoices needs in order
 * to go and find `B, C, D`.
 *
 * A number printed twice on one page yields two blocks. Callers pick between
 * them by comparing the stems to the question they are actually looking for.
 */
export function questionsOnPage(pageText: string): PageQuestion[] {
  const text = pageText ?? ''

  const starts: { number: number; at: number; bodyFrom: number }[] = []
  NUMBERED_LINE.lastIndex = 0

  for (let match = NUMBERED_LINE.exec(text); match; match = NUMBERED_LINE.exec(text)) {
    starts.push({
      number: Number(match[1]),
      at: match.index,
      bodyFrom: match.index + match[0].length - match[2].length,
    })
  }

  return starts.map((start, index) => {
    const block = text.slice(start.bodyFrom, starts[index + 1]?.at ?? text.length)

    const marks: { label: string; at: number; textFrom: number }[] = []
    OPTION_LINE.lastIndex = 0

    for (let match = OPTION_LINE.exec(block); match; match = OPTION_LINE.exec(block)) {
      marks.push({
        label: match[1].toUpperCase(),
        at: match.index,
        textFrom: match.index + match[0].length - match[2].length,
      })
    }

    // The run has to open the block at A. A block whose first option is B is
    // the tail of a list whose head is on the page before, and it belongs to
    // the question there, not to this one.
    let options: PageOption[] = []
    for (const [position, mark] of marks.entries()) {
      if (mark.label.charCodeAt(0) !== A + position) break

      // An option runs to the next one, so a wrapped option keeps its second
      // line. The last one runs to the end of the block, which is why the cap
      // matters: past a few hundred characters this is prose, not an answer.
      const endsAt = marks[position + 1]?.at ?? block.length
      const body = block.slice(mark.textFrom, endsAt).trim()

      if (body.length === 0 || body.length > MAX_OPTION_TEXT) break

      // `(A) 2 (B) 4 (C) 5 (D) 6` opens a line like a proper option and then
      // holds the entire list, so A comes back carrying B, C and D as its
      // text. That is the inline form this parser does not read, and one
      // option whose text is four options is worse than none: bail on the
      // whole block rather than store it.
      if (nextLabelInside(body, A + position + 1)) {
        options = []
        break
      }

      options.push({ label: mark.label, text: normalizeMath(body) })
    }

    const stemEnd = marks[0]?.at ?? block.length

    return {
      number: start.number,
      stem: normalizeMath(block.slice(0, stemEnd).trim()),
      options,
    }
  })
}
