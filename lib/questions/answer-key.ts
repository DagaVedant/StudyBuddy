/**
 * Reads the answer key a paper prints after its questions.
 *
 * Every practice paper in the Edison set ends with one, and until now the
 * pipeline walked straight past it: 288 questions were stored across fourteen
 * sheets and not one of them had a correct answer recorded, which leaves
 * nothing to mark a student against. The keys are in the text layer already, so
 * this costs one regex pass and no model call.
 *
 * Two printed forms, both of which appear in the same document:
 *
 *   1. D  2. C  3. A  4. C  5. B      a grid, usually under an "ANSWER KEY" heading
 *   12. Answer: B                     one line per worked solution
 *
 * Being wrong here is expensive: a wrong key marks a right answer wrong, and
 * the student has no way to tell it was the paper's fault, so both readers are
 * deliberately literal, and anything the two disagree about is thrown away
 * rather than guessed at.
 */

/** Labels a multiple-choice paper actually uses. */
const LABEL = '[A-Ea-e]'

/**
 * One worked solution announcing its answer. Specific enough to trust wherever
 * it appears, because no question stem reads "7. Answer: C".
 */
const SOLUTION_LINE = new RegExp(`(?:^|\\s)(\\d{1,3})[.)]\\s*Answer:?\\s*\\(?(${LABEL})\\)?`, 'g')

/**
 * A row of the key grid, and nothing else.
 *
 * Anchored to the whole line on purpose. A loose "number then letter" match
 * also fires on "4. A rectangular concrete slab has a width of…", which is a
 * question, and mistaking one for a key entry silently answers the paper wrong.
 */
const GRID_LINE = new RegExp(`^(?:\\d{1,3}[.)]\\s*\\(?${LABEL}\\)?[\\s,;]*)+$`)
const GRID_PAIR = new RegExp(`(\\d{1,3})[.)]\\s*\\(?(${LABEL})\\)?`, 'g')

/**
 * Fewest entries a page must yield before its key is believed.
 *
 * A real key covers a whole paper. One or two matches on a page is a
 * coincidence of punctuation, and acting on a coincidence is how a question
 * ends up marked against the wrong letter.
 */
const MIN_ENTRIES = 3

/** Strips the inline markup the text layer sometimes carries, e.g. `<b>1.</b> B`. */
function stripTags(text: string): string {
  return text.replace(/<\/?[a-z][a-z0-9]{0,7}\s*\/?>/gi, '')
}

/**
 * Every answer the page states, keyed by printed question number.
 *
 * Returns an empty map for an ordinary question page, and for a key page whose
 * two readings contradict each other.
 */
export function parseAnswerKey(pageText: string): Map<number, string> {
  const text = stripTags(pageText ?? '')
  if (text.trim().length === 0) return new Map()

  // Collected per number rather than written straight in, so a number the grid
  // and the solutions disagree about can be dropped instead of raced over.
  const seen = new Map<number, Set<string>>()

  const record = (number: number, label: string) => {
    if (number < 1) return
    const set = seen.get(number) ?? new Set<string>()
    set.add(label.toUpperCase())
    seen.set(number, set)
  }

  SOLUTION_LINE.lastIndex = 0
  for (let match = SOLUTION_LINE.exec(text); match; match = SOLUTION_LINE.exec(text)) {
    record(Number(match[1]), match[2])
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0 || !GRID_LINE.test(line)) continue

    GRID_PAIR.lastIndex = 0
    for (let match = GRID_PAIR.exec(line); match; match = GRID_PAIR.exec(line)) {
      record(Number(match[1]), match[2])
    }
  }

  const key = new Map<number, string>()
  for (const [number, labels] of seen) {
    // Two readings that disagree mean one of them read something that was not
    // a key at all. Neither is worth keeping.
    if (labels.size !== 1) continue
    key.set(number, [...labels][0])
  }

  return key.size >= MIN_ENTRIES ? key : new Map()
}

/**
 * Folds the keys found on each page into one, dropping any number the pages
 * disagree about.
 *
 * Papers print the same answers twice, once as a grid, once alongside the
 * worked solutions, so agreement across pages is ordinary and a contradiction
 * is a signal that something was misread.
 */
export function mergeAnswerKeys(keys: Map<number, string>[]): Map<number, string> {
  const seen = new Map<number, Set<string>>()

  for (const key of keys) {
    for (const [number, label] of key) {
      const set = seen.get(number) ?? new Set<string>()
      set.add(label)
      seen.set(number, set)
    }
  }

  const merged = new Map<number, string>()
  for (const [number, labels] of seen) {
    if (labels.size === 1) merged.set(number, [...labels][0])
  }

  return merged
}
