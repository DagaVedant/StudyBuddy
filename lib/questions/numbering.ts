/**
 * Printed numbers: reading them off a page, and working out the ones that are
 * missing.
 *
 * Three files until they were merged, and they only ever ran in one order:
 * `questionsOnPage` reads what the page actually prints, `printedNumbersFor`
 * turns that into the numbers a page carries, and `inferPrintedNumbers` fills
 * the gaps for questions no page stated a number for. The first two had a
 * single caller each and it was the next function down.
 */

import { normalizeMath } from './math'

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

/**
 * The number a page prints a question under, taken from the page rather than
 * from the model.
 *
 * Extraction returns an `ordinal` per question and ingest stored it as the
 * printed number verbatim. That holds while a page is read as part of the whole
 * paper and breaks the moment one is read on its own: the audit re-reads a page
 * to recover the questions it is missing, the model numbers what it can see
 * from 1, and those numbers are stored over the real ones. Re-reading page 2 of
 * `topic_test3_20` for its missing 9-16 filed them as 1-7, on top of page 1's
 * real 1-7, so the sheet came out of a repair holding seven duplicate numbers
 * and still missing seven questions.
 *
 * The page already says what it prints. `questionsOnPage` reads "9. <stem>"
 * out of the text layer, so a question can be matched back to the stem it came
 * from and given that stem's number, with no model call and nothing inferred.
 */

/** Below this a prompt is too short to identify a stem safely. */
const MIN_MATCH = 24

/** How much of the two strings has to agree. */
const COMPARE = 40

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function sameOpening(a: string, b: string): boolean {
  const left = a.slice(0, COMPARE)
  const right = b.slice(0, COMPARE)
  if (left.length < MIN_MATCH || right.length < MIN_MATCH) return false
  return left.startsWith(right) || right.startsWith(left)
}

/**
 * For each prompt, the number the page prints it under, or null.
 *
 * Null rather than a guess: a caller that cannot be told keeps whatever it had,
 * and a wrong number is worse than the model's, because it silently claims to
 * be the paper's own.
 *
 * A page number is handed out at most once. Two prompts that open identically
 * are two rows of one question far more often than they are two questions, and
 * giving both the same number would rebuild the collision this exists to stop.
 */
export function printedNumbersFor(
  pageText: string,
  prompts: readonly string[],
): (number | null)[] {
  const stems = questionsOnPage(pageText ?? '').map((question) => ({
    number: question.number,
    head: normalize(question.stem),
  }))

  if (stems.length === 0) return prompts.map(() => null)

  const taken = new Set<number>()

  return prompts.map((prompt) => {
    const head = normalize(prompt ?? '')

    const hit = stems.find((stem) => !taken.has(stem.number) && sameOpening(stem.head, head))
    if (!hit) return null

    taken.add(hit.number)
    return hit.number
  })
}

/**
 * Works out the number a question was printed with when the model lost it.
 *
 * Across two real papers every "missing" question but one turned out to be
 * present and mislabelled: three arrived with no number at all, and question
 * 113 arrived labelled 1. The questions were read correctly; only the label
 * failed, and the label is what coverage is measured against.
 *
 * Position is the evidence. A question sitting on page 5 between question 3
 * and question 5, on a paper whose only gap is 4, is question 4. Nothing else
 * it could be.
 *
 * Deliberately refuses to guess. A number is assigned only when exactly one
 * candidate fits the space, so an ambiguous run is left for the student rather
 * than filled with a plausible lie. A wrong number is worse than a blank one:
 * blank is visibly unfinished, wrong looks finished and is not.
 */
export interface NumberedQuestion {
  id: string
  /** Page it was found on. Null sorts last, as an unplaced question. */
  pageNumber: number | null
  /** Order within the whole worksheet, used to break ties inside a page. */
  position: number
  printedNumber: number | null
}

export interface NumberFix {
  id: string
  from: number | null
  to: number
  reason: 'filled-blank' | 'corrected-stray'
}

function inOrder(items: NumberedQuestion[]): NumberedQuestion[] {
  return [...items].sort((a, b) => {
    const pageA = a.pageNumber ?? Number.MAX_SAFE_INTEGER
    const pageB = b.pageNumber ?? Number.MAX_SAFE_INTEGER
    if (pageA !== pageB) return pageA - pageB
    return a.position - b.position
  })
}

/**
 * Numbers we can believe, which is what everything else is measured against.
 *
 * A number is trusted when it appears exactly once and does not go backwards
 * against the numbers around it. Both tests matter: the stray 1 on the last
 * page of a 114 question paper was a duplicate *and* out of sequence, and
 * either check alone would have let one of the real failures through.
 */
function trustedNumbers(ordered: NumberedQuestion[]): Map<string, number> {
  const seen = new Map<number, number>()
  for (const item of ordered) {
    if (item.printedNumber !== null) {
      seen.set(item.printedNumber, (seen.get(item.printedNumber) ?? 0) + 1)
    }
  }

  const unique = ordered.filter(
    (item) => item.printedNumber !== null && seen.get(item.printedNumber) === 1,
  )

  // Longest run of numbers that only ever increases. Anything off that run is
  // out of place relative to its neighbours, whatever its value.
  const best: number[] = []
  const from: number[] = new Array(unique.length).fill(-1)
  const length: number[] = new Array(unique.length).fill(1)

  for (let i = 0; i < unique.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      const rising = (unique[j].printedNumber as number) < (unique[i].printedNumber as number)
      if (rising && length[j] + 1 > length[i]) {
        length[i] = length[j] + 1
        from[i] = j
      }
    }
  }

  let end = length.indexOf(Math.max(...length, 0))
  while (end >= 0) {
    best.unshift(end)
    end = from[end]
  }

  const trusted = new Map<string, number>()
  for (const index of best) {
    const item = unique[index]
    trusted.set(item.id, item.printedNumber as number)
  }
  return trusted
}

export function inferPrintedNumbers(
  items: NumberedQuestion[],
  expectedTotal: number | null,
): NumberFix[] {
  if (items.length === 0) return []

  const ordered = inOrder(items)
  const trusted = trustedNumbers(ordered)
  if (trusted.size === 0) return []

  // Everything the paper should have, minus what we already believe.
  const ceiling = expectedTotal && expectedTotal > 0
    ? expectedTotal
    : Math.max(...trusted.values())

  const taken = new Set(trusted.values())
  const available: number[] = []
  for (let n = 1; n <= ceiling; n += 1) if (!taken.has(n)) available.push(n)
  if (available.length === 0) return []

  const fixes: NumberFix[] = []

  // Walk the runs of unreliable questions between two trusted anchors.
  let index = 0
  while (index < ordered.length) {
    if (trusted.has(ordered[index].id)) {
      index += 1
      continue
    }

    let end = index
    while (end < ordered.length && !trusted.has(ordered[end].id)) end += 1

    const run = ordered.slice(index, end)

    // A run at the very start has no lower anchor, so the floor is 0; at the
    // very end there is no upper anchor, so the ceiling is the paper's total.
    let low = 0
    for (let back = index - 1; back >= 0; back -= 1) {
      const anchor = trusted.get(ordered[back].id)
      if (anchor !== undefined) { low = anchor; break }
    }

    let high = ceiling + 1
    for (let forward = end; forward < ordered.length; forward += 1) {
      const anchor = trusted.get(ordered[forward].id)
      if (anchor !== undefined) { high = anchor; break }
    }

    const candidates = available.filter((n) => n > low && n < high)

    // Only when the space and the questions in it match exactly. One spare
    // number and two blanks is a guess, and this does not guess.
    if (candidates.length === run.length) {
      for (const [offset, item] of run.entries()) {
        const to = candidates[offset]
        if (item.printedNumber === to) continue
        fixes.push({
          id: item.id,
          from: item.printedNumber,
          to,
          reason: item.printedNumber === null ? 'filled-blank' : 'corrected-stray',
        })
      }
    }

    index = end
  }

  return fixes
}
