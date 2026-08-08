/**
 * Rejoins the lines a worksheet wrapped, so a question fills the width it gets.
 *
 * Extraction reads paper a line at a time, so a stem that ran to three lines in
 * a narrow print column arrives carrying two hard breaks. Rendered in a card
 * that is wider than the column ever was, those breaks land mid-sentence and
 * leave a ragged half-filled block: `...product of the two numbers rolled` and
 * then a new line for `is a multiple of 6.` The break is an artefact of the
 * page it was printed on, not of the question.
 *
 * Not solved by dropping `whitespace-pre-line` at the point of rendering,
 * because some breaks are real. A `which of I, II and III` stem lists its
 * numerals one per line, and a lead-in that carried its answer choices into the
 * prompt reads as a list too. Those keep their own line; everything else is
 * treated as a wrap and joined.
 */

/** A line that starts its own item: a bullet, a numbered step, a choice label. */
const ITEM_START = /^(?:[-•*·–—]\s|\(?(?:[IVX]{1,4}|[A-H]|\d{1,2})[).]\s)/

export function reflowText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    // A blank line is a paragraph the author meant, so it survives as one.
    .split(/\n{2,}/)
    .map((paragraph) => {
      const lines = paragraph
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)

      return lines.reduce((joined, line) => {
        if (!joined) return line
        if (ITEM_START.test(line)) return `${joined}\n${line}`
        // A word the typesetter split across the wrap: the hyphen belongs to
        // the column width rather than to the word.
        if (/[a-z]-$/.test(joined) && /^[a-z]/.test(line)) {
          return `${joined.slice(0, -1)}${line}`
        }
        return `${joined} ${line}`
      }, '')
    })
    .filter(Boolean)
    .join('\n\n')
    .trim()
}
