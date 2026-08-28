import {
  firstQuestionAt,
  type PagePosition,
  sortWithinPage,
  normalizeForCompare,
  normalizeMath,
  normalizeOptionText,
} from './shape'

export type PageOption = {
  label: string
  text: string
}

export type PageQuestion = {
  number: number
  stem: string
  options: PageOption[]
}

const NUMBERED_LINE = /^[ \t]*\(?(\d{1,3})[.)][ \t]+(.*)$/gm
const OPTION_LINE = /^[ \t]*\(?([A-Za-z])[).][ \t]+(.*)$/gm
const MAX_OPTION_TEXT = 300

const A = 'A'.charCodeAt(0)

function nextLabelInside(body: string, code: number) {
  if (code > 'Z'.charCodeAt(0)) return false

  const label = String.fromCharCode(code)
  const lower = label.toLowerCase()

  const pattern =
    '(?<![\\p{L}\\p{N}])\\(?[' + label + lower + '][).][ \\t]'

  return new RegExp(pattern, 'u').test(body)
}

type Mark = { label: string; at: number; textFrom: number }

function optionMarks(block: string): Mark[] {
  const marks: Mark[] = []
  OPTION_LINE.lastIndex = 0

  for (let match = OPTION_LINE.exec(block); match; match = OPTION_LINE.exec(block)) {
    marks.push({
      label: match[1].toUpperCase(),
      at: match.index,
      textFrom: match.index + match[0].length - match[2].length,
    })
  }

  return marks
}

function questionsOnPage(pageText: string): PageQuestion[] {
  const starts: { number: number; at: number; bodyFrom: number }[] = []
  NUMBERED_LINE.lastIndex = 0

  for (let match = NUMBERED_LINE.exec(pageText); match; match = NUMBERED_LINE.exec(pageText)) {
    starts.push({
      number: Number(match[1]),
      at: match.index,
      bodyFrom: match.index + match[0].length - match[2].length,
    })
  }

  const found: PageQuestion[] = []

  for (let index = 0; index < starts.length; index++) {
    const start = starts[index]

    let blockEnd = pageText.length
    if (starts[index + 1]) blockEnd = starts[index + 1].at

    const block = pageText.slice(start.bodyFrom, blockEnd)
    const marks = optionMarks(block)

    let options: PageOption[] = []

    for (let position = 0; position < marks.length; position++) {
      const mark = marks[position]
      if (mark.label.charCodeAt(0) !== A + position) break

      let endsAt = block.length
      if (marks[position + 1]) endsAt = marks[position + 1].at

      const body = block.slice(mark.textFrom, endsAt).trim()

      if (body.length === 0 || body.length > MAX_OPTION_TEXT) break

      if (nextLabelInside(body, A + position + 1)) {
        options = []
        break
      }

      options.push({ label: mark.label, text: normalizeMath(body) })
    }

    let stemEnd = block.length
    if (marks.length > 0) stemEnd = marks[0].at

    found.push({
      number: start.number,
      stem: normalizeMath(block.slice(0, stemEnd).trim()),
      options,
    })
  }

  return found
}

const MIN_MATCH = 24
const COMPARE = 40

function normalize(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function sameOpening(a: string, b: string) {
  const left = a.slice(0, COMPARE)
  const right = b.slice(0, COMPARE)

  if (left.length < MIN_MATCH || right.length < MIN_MATCH) return false

  return left.startsWith(right) || right.startsWith(left)
}

export function printedNumbersFor(pageText: string, prompts: readonly string[]) {
  const found = questionsOnPage(pageText)

  const stems: { number: number; head: string }[] = []
  for (const question of found) {
    stems.push({ number: question.number, head: normalize(question.stem) })
  }

  const numbers: (number | null)[] = []

  if (stems.length === 0) {
    for (let i = 0; i < prompts.length; i++) numbers.push(null)
    return numbers
  }

  const taken = new Set<number>()

  for (const prompt of prompts) {
    const head = normalize(prompt)

    let hit = null
    for (const stem of stems) {
      if (taken.has(stem.number)) continue
      if (!sameOpening(stem.head, head)) continue

      hit = stem
      break
    }

    if (!hit) {
      numbers.push(null)
      continue
    }

    taken.add(hit.number)
    numbers.push(hit.number)
  }

  return numbers
}

export type NumberedQuestion = {
  id: string
  pageNumber: number | null
  position: number
  printedNumber: number | null
}

export type NumberFix = {
  id: string
  from: number | null
  to: number
  reason: 'filled-blank' | 'corrected-stray'
}

function inOrder(items: NumberedQuestion[]) {
  const ordered = items.slice()

  ordered.sort(function (a, b) {
    let pageA = a.pageNumber
    if (pageA === null) pageA = Number.MAX_SAFE_INTEGER

    let pageB = b.pageNumber
    if (pageB === null) pageB = Number.MAX_SAFE_INTEGER

    if (pageA !== pageB) return pageA - pageB

    return a.position - b.position
  })

  return ordered
}

function trustedNumbers(ordered: NumberedQuestion[]) {
  const seen = new Map<number, number>()

  for (const item of ordered) {
    if (item.printedNumber === null) continue

    let count = seen.get(item.printedNumber)
    if (count === undefined) count = 0

    seen.set(item.printedNumber, count + 1)
  }

  const unique: { id: string; number: number }[] = []

  for (const item of ordered) {
    if (item.printedNumber === null) continue
    if (seen.get(item.printedNumber) !== 1) continue

    unique.push({ id: item.id, number: item.printedNumber })
  }

  const from: number[] = []
  const length: number[] = []

  for (let i = 0; i < unique.length; i++) {
    from.push(-1)
    length.push(1)
  }

  for (let i = 0; i < unique.length; i++) {
    for (let j = 0; j < i; j++) {
      if (unique[j].number >= unique[i].number) continue

      if (length[j] + 1 > length[i]) {
        length[i] = length[j] + 1
        from[i] = j
      }
    }
  }

  let longest = 0
  for (const value of length) {
    if (value > longest) longest = value
  }

  let end = length.indexOf(longest)

  const best: number[] = []
  while (end >= 0) {
    best.unshift(end)
    end = from[end]
  }

  const trusted = new Map<string, number>()
  for (const index of best) trusted.set(unique[index].id, unique[index].number)

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

  let ceiling = 0

  if (expectedTotal && expectedTotal > 0) {
    ceiling = expectedTotal
  } else {
    for (const number of trusted.values()) {
      if (number > ceiling) ceiling = number
    }
  }

  const taken = new Set(trusted.values())

  const available: number[] = []
  for (let n = 1; n <= ceiling; n++) {
    if (!taken.has(n)) available.push(n)
  }

  if (available.length === 0) return []

  const fixes: NumberFix[] = []

  let index = 0

  while (index < ordered.length) {
    if (trusted.has(ordered[index].id)) {
      index = index + 1
      continue
    }

    let end = index
    while (end < ordered.length && !trusted.has(ordered[end].id)) end = end + 1

    const run = ordered.slice(index, end)

    let low = 0
    for (let back = index - 1; back >= 0; back--) {
      const anchor = trusted.get(ordered[back].id)
      if (anchor !== undefined) {
        low = anchor
        break
      }
    }

    let high = ceiling + 1
    for (let forward = end; forward < ordered.length; forward++) {
      const anchor = trusted.get(ordered[forward].id)
      if (anchor !== undefined) {
        high = anchor
        break
      }
    }

    const candidates: number[] = []
    for (const n of available) {
      if (n > low && n < high) candidates.push(n)
    }

    if (candidates.length === run.length) {
      for (let offset = 0; offset < run.length; offset++) {
        const item = run[offset]
        const to = candidates[offset]
        if (item.printedNumber === to) continue

        let reason: 'filled-blank' | 'corrected-stray' = 'corrected-stray'
        if (item.printedNumber === null) reason = 'filled-blank'

        fixes.push({ id: item.id, from: item.printedNumber, to, reason })
      }
    }

    index = end
  }

  return fixes
}

export type DuplicateCandidate = {
  id: string
  printedNumber: number | null
  promptText: string
  choices: { label: string; text: string }[]
}

export type MergePlan = {
  keepId: string
  dropId: string
  printedNumber: number | null
}

function isAlphabetic(label: string) {
  return /^[a-z]$/i.test(label.trim())
}

function isNumeric(label: string) {
  return /^\d+$/.test(label.trim())
}

function labelStyle(choices: { label: string }[]) {
  if (choices.length === 0) return 'mixed'

  let alpha = true
  let numeric = true

  for (const choice of choices) {
    if (!isAlphabetic(choice.label)) alpha = false
    if (!isNumeric(choice.label)) numeric = false
  }

  if (alpha) return 'alpha'
  if (numeric) return 'numeric'

  return 'mixed'
}

function choicesAreContainedIn(inner: { text: string }[], outer: { text: string }[]) {
  if (inner.length === 0 || outer.length === 0) return false

  const haystacks: string[] = []
  for (const choice of outer) {
    const text = normalizeForCompare(choice.text)
    if (text) haystacks.push(text)
  }

  if (haystacks.length === 0) return false

  for (const choice of inner) {
    const needle = normalizeForCompare(choice.text)
    if (needle.length < 12) return false

    let found = false
    for (const hay of haystacks) {
      if (hay.includes(needle)) {
        found = true
        break
      }
    }

    if (!found) return false
  }

  return true
}

export function planDuplicateMerges(questions: DuplicateCandidate[]): MergePlan[] {
  const byPrompt = new Map<string, DuplicateCandidate[]>()

  for (const question of questions) {
    const key = normalizeForCompare(question.promptText)
    if (!key) continue

    const list = byPrompt.get(key)
    if (list) list.push(question)
    else byPrompt.set(key, [question])
  }

  const plans: MergePlan[] = []

  for (const group of byPrompt.values()) {
    if (group.length !== 2) continue

    const a = group[0]
    const b = group[1]

    const styleA = labelStyle(a.choices)
    const styleB = labelStyle(b.choices)

    let real: DuplicateCandidate
    let phantom: DuplicateCandidate

    if (styleA === 'alpha' && styleB === 'numeric') {
      real = a
      phantom = b
    } else if (styleB === 'alpha' && styleA === 'numeric') {
      real = b
      phantom = a
    } else {
      continue
    }

    if (!choicesAreContainedIn(phantom.choices, real.choices)) continue

    let printedNumber: number | null = null

    if (typeof real.printedNumber === 'number') printedNumber = real.printedNumber

    if (typeof phantom.printedNumber === 'number') {
      if (printedNumber === null || phantom.printedNumber < printedNumber) {
        printedNumber = phantom.printedNumber
      }
    }

    plans.push({ keepId: real.id, dropId: phantom.id, printedNumber })
  }

  return plans
}

export function duplicatePrintedNumbers(questions: { printedNumber: number | null }[]) {
  const counts = new Map<number, number>()

  for (const question of questions) {
    if (typeof question.printedNumber !== 'number') continue

    let count = counts.get(question.printedNumber)
    if (count === undefined) count = 0

    counts.set(question.printedNumber, count + 1)
  }

  const repeated: number[] = []
  for (const [number, count] of counts) {
    if (count > 1) repeated.push(number)
  }

  repeated.sort(function (a, b) {
    return a - b
  })

  return repeated
}

function wordSet(text: string) {
  const words = new Set<string>()

  for (const word of normalizeForCompare(text).split(' ')) {
    if (word) words.add(word)
  }

  return words
}

function promptSimilarity(left: string, right: string) {
  const a = wordSet(left)
  const b = wordSet(right)

  if (a.size === 0 || b.size === 0) return 0

  let shared = 0
  for (const word of a) {
    if (b.has(word)) shared = shared + 1
  }

  return shared / (a.size + b.size - shared)
}

const SAME_QUESTION_SIMILARITY = 0.8

function countMatches(text: string, pattern: RegExp) {
  const found = text.match(pattern)
  if (!found) return 0

  return found.length
}

const BARE_UNDERSCORE = /(?:^|\s)_(?:\s|$)/g
const UNDERSCORE_DIGIT = /_\s*\d/g

function damage(question: DuplicateCandidate, expectedChoices: number) {
  const text = question.promptText
  let score = 0

  score = score + countMatches(text, BARE_UNDERSCORE) * 3
  score = score + countMatches(text, UNDERSCORE_DIGIT) * 2

  if (question.choices.length !== expectedChoices) score = score + 4
  if (text.trim().length < 25) score = score + 5

  return score
}

function shorterIsCut(short: DuplicateCandidate, long: DuplicateCandidate) {
  if (short.choices.length > 0 || long.choices.length === 0) return false
  if (short.promptText.length >= long.promptText.length) return false

  const words = wordSet(short.promptText)
  if (words.size === 0) return false

  const inLong = wordSet(long.promptText)
  for (const word of words) {
    if (!inLong.has(word)) return false
  }

  return true
}

export function planNumberDuplicateMerges(
  questions: DuplicateCandidate[],
  expectedChoices: number,
): MergePlan[] {
  const byNumber = new Map<number, DuplicateCandidate[]>()

  for (const question of questions) {
    if (question.printedNumber === null) continue

    const list = byNumber.get(question.printedNumber)
    if (list) list.push(question)
    else byNumber.set(question.printedNumber, [question])
  }

  const plans: MergePlan[] = []

  for (const [printedNumber, group] of byNumber) {
    if (group.length !== 2) continue

    const a = group[0]
    const b = group[1]

    if (shorterIsCut(a, b)) {
      plans.push({ keepId: b.id, dropId: a.id, printedNumber })
      continue
    }

    if (shorterIsCut(b, a)) {
      plans.push({ keepId: a.id, dropId: b.id, printedNumber })
      continue
    }

    if (promptSimilarity(a.promptText, b.promptText) < SAME_QUESTION_SIMILARITY) continue

    let keep = b
    let drop = a

    if (damage(a, expectedChoices) <= damage(b, expectedChoices)) {
      keep = a
      drop = b
    }

    plans.push({ keepId: keep.id, dropId: drop.id, printedNumber })
  }

  return plans
}

export type CarriedChoice = {
  label: string
  text: string
}

const OPTION = /(?<![\p{L}\p{N}])\(?([A-Za-z])[).][ \t]+/gu

function heldLabels(raw: string[]) {
  const letters = new Set<string>()

  for (const value of raw) {
    const label = value.trim().toUpperCase()
    if (/^[A-Z]$/.test(label)) letters.add(label)
  }

  const sorted = Array.from(letters)
  sorted.sort()

  return sorted
}

export type CarriedChoiceOptions = {
  expectedCount?: number | null
  held?: string[]
}

export function parseCarriedChoices(
  pageText: string,
  options: CarriedChoiceOptions = {},
): CarriedChoice[] | null {
  if (pageText.trim().length === 0) return null

  let expected: number | null = null
  if (options.expectedCount !== undefined && options.expectedCount !== null) {
    expected = options.expectedCount
  }

  let raw: string[] = []
  if (options.held) raw = options.held

  const held = heldLabels(raw)

  let startCode = A
  let need: number | null = expected

  if (held.length > 0) {
    for (let index = 0; index < held.length; index++) {
      if (held[index].charCodeAt(0) !== A + index) return null
    }

    if (expected === null || held.length >= expected) return null

    startCode = A + held.length
    need = expected - held.length
  }

  const head = pageText.slice(0, firstQuestionAt(pageText))
  if (head.trim().length === 0) return null

  const marks: Mark[] = []
  OPTION.lastIndex = 0

  for (let match = OPTION.exec(head); match; match = OPTION.exec(head)) {
    marks.push({
      label: match[1].toUpperCase(),
      at: match.index,
      textFrom: match.index + match[0].length,
    })
  }

  let minimum = 3
  if (held.length > 0 && need !== null) minimum = need

  if (marks.length < minimum) return null

  let start = -1
  for (let index = 0; index < marks.length; index++) {
    if (marks[index].label.charCodeAt(0) === startCode) {
      start = index
      break
    }
  }

  if (start === -1) return null

  if (held.length > 0 && start !== 0) return null

  const run: CarriedChoice[] = []
  let expectedCode = startCode

  for (let index = start; index < marks.length; index++) {
    const mark = marks[index]
    if (mark.label.charCodeAt(0) !== expectedCode) break

    let endsAt = head.length
    if (marks[index + 1]) endsAt = marks[index + 1].at

    const body = head.slice(mark.textFrom, endsAt).trim()

    if (body.length === 0 || body.length > MAX_OPTION_TEXT) break

    run.push({ label: mark.label, text: normalizeMath(body) })
    expectedCode = expectedCode + 1
  }

  if (run.length < minimum) return null

  if (need !== null && run.length !== need) return null

  return run
}

export type ValidationFlag = {
  code: string
  detail: string
  severity: 'high' | 'low'
}

export type ValidatableQuestion = {
  printedNumber: number | null
  promptText: string
  questionType: string
  choices: { label: string; text: string }[]
}

const CHOICE_BEARING = new Set(['multiple_choice', 'true_false'])

export function modalChoiceCount(questions: ValidatableQuestion[]) {
  const counts = new Map<number, number>()

  for (const question of questions) {
    if (!CHOICE_BEARING.has(question.questionType)) continue

    const n = question.choices.length
    if (n === 0) continue

    let count = counts.get(n)
    if (count === undefined) count = 0

    counts.set(n, count + 1)
  }

  let best: number | null = null
  let bestSeen = 0
  let tied = false

  for (const [n, seen] of counts) {
    if (seen > bestSeen) {
      best = n
      bestSeen = seen
      tied = false
    } else if (seen === bestSeen) {
      tied = true
    }
  }

  if (tied || bestSeen < 3) return null

  return best
}

const CUT_OFF = /[,;\-–—(\[]\s*$/

const PROSE = /[a-z]{3,}/g

const MATHS = /[=<>+−×÷≤≥]|\d+\s*[-*/]\s*\d+/
const HAS_QUESTION_SHAPE = /[?:]/

const ASKS = /\?/

const OPEN_QUOTE = /[“]/g
const CLOSE_QUOTE = /[”]/g

const OPTION_MARK = /(?<![\p{L}\p{N}])\(?([A-Za-z])[).][ \t]+/gu

export function isOptionRun(text: string) {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false

  const marks: Mark[] = []
  OPTION_MARK.lastIndex = 0

  for (let match = OPTION_MARK.exec(trimmed); match; match = OPTION_MARK.exec(trimmed)) {
    marks.push({
      label: match[1].toUpperCase(),
      at: match.index,
      textFrom: match.index + match[0].length,
    })
  }

  if (marks.length < 3) return false

  if (trimmed.slice(0, marks[0].at).trim().length > 0) return false

  const first = marks[0].label.charCodeAt(0)
  if (first < 'A'.charCodeAt(0) || first > 'E'.charCodeAt(0)) return false

  for (let index = 0; index < marks.length; index++) {
    if (marks[index].label.charCodeAt(0) !== first + index) return false
  }

  for (let index = 0; index < marks.length; index++) {
    let endsAt = trimmed.length
    if (marks[index + 1]) endsAt = marks[index + 1].at

    const body = trimmed.slice(marks[index].textFrom, endsAt).trim()

    if (body.length === 0 || body.length > MAX_OPTION_TEXT) return false
  }

  return true
}

export function validateQuestion(
  question: ValidatableQuestion,
  options: { expectedChoiceCount?: number | null } = {},
): ValidationFlag[] {
  const flags: ValidationFlag[] = []
  const stem = question.promptText.trim()
  const normalizedStem = normalizeForCompare(stem)

  if (normalizedStem.length < 10) {
    flags.push({
      code: 'empty_stem',
      detail: 'stem is ' + normalizedStem.length + ' characters',
      severity: 'high',
    })
  }

  const wantsChoices = CHOICE_BEARING.has(question.questionType)

  if (wantsChoices && question.choices.length === 0) {
    flags.push({
      code: 'no_choices',
      detail: 'multiple choice with no options',
      severity: 'high',
    })
  }

  let expected: number | null = null
  if (options.expectedChoiceCount !== undefined && options.expectedChoiceCount !== null) {
    expected = options.expectedChoiceCount
  }

  if (
    wantsChoices &&
    expected !== null &&
    question.choices.length > 0 &&
    question.choices.length < expected
  ) {
    flags.push({
      code: 'too_few_choices',
      detail: question.choices.length + ' options where this paper uses ' + expected,
      severity: 'high',
    })
  }

  const seenText = new Set<string>()
  const seenLabel = new Set<string>()

  for (const choice of question.choices) {
    const text = normalizeOptionText(choice.text)
    const label = normalizeForCompare(choice.label)
    const prose = normalizeForCompare(choice.text)

    if (text.length > 0) {
      if (seenText.has(text)) {
        flags.push({
          code: 'duplicate_choices',
          detail: 'two options read "' + choice.text.slice(0, 40) + '"',
          severity: 'high',
        })
      }

      seenText.add(text)
    }

    if (label.length > 0) {
      if (seenLabel.has(label)) {
        flags.push({
          code: 'duplicate_labels',
          detail: 'label ' + choice.label + ' appears twice',
          severity: 'high',
        })
      }

      seenLabel.add(label)
    }

    if (prose.length >= 12 && normalizedStem.includes(prose)) {
      flags.push({
        code: 'choice_text_in_stem',
        detail: 'option ' + choice.label + ' also appears in the stem',
        severity: 'low',
      })
    }
  }

  const openQuotes = countMatches(stem, OPEN_QUOTE)
  const closeQuotes = countMatches(stem, CLOSE_QUOTE)

  if (normalizedStem.length >= 25 && (CUT_OFF.test(stem) || openQuotes > closeQuotes)) {
    flags.push({
      code: 'stem_looks_truncated',
      detail: 'stem ends "' + stem.slice(-24) + '"',
      severity: 'low',
    })
  }

  if (!ASKS.test(stem) && countMatches(stem, PROSE) < 3 && !MATHS.test(stem)) {
    flags.push({
      code: 'stem_is_not_a_question',
      detail: 'nothing asked: "' + stem.slice(0, 40) + '"',
      severity: 'high',
    })
  }

  if (isOptionRun(stem)) {
    flags.push({
      code: 'stem_is_only_options',
      detail: 'options with no question: "' + stem.slice(0, 40) + '"',
      severity: 'high',
    })
  }

  if (normalizedStem.length > 600 && !HAS_QUESTION_SHAPE.test(stem)) {
    flags.push({
      code: 'stem_reads_like_passage',
      detail: normalizedStem.length + ' characters with no question mark',
      severity: 'low',
    })
  }

  return flags
}

export function worthRereading(flags: ValidationFlag[]) {
  let low = 0

  for (const flag of flags) {
    if (flag.severity === 'high') return true
    if (flag.severity === 'low') low = low + 1
  }

  return low >= 2
}

export type SplitHalf = ValidatableQuestion &
  PagePosition & {
    id: string
    pageNumber: number | null
  }

export type SplitJoin = {
  keepId: string
  dropId: string
  printedNumber: number | null
  reason: string
}

function flagCodes(question: ValidatableQuestion) {
  const codes = new Set<string>()
  for (const flag of validateQuestion(question)) codes.add(flag.code)

  return codes
}

function asksSomething(question: SplitHalf) {
  const codes = flagCodes(question)

  return !codes.has('stem_is_not_a_question') && !codes.has('empty_stem')
}

function asksNothing(question: SplitHalf) {
  return flagCodes(question).has('stem_is_not_a_question')
}

export function planPageSplitJoins(
  questions: SplitHalf[],
  options: { expectedChoiceCount?: number | null } = {},
): SplitJoin[] {
  const byPage = new Map<number, SplitHalf[]>()

  for (const question of questions) {
    if (question.pageNumber === null) continue

    const list = byPage.get(question.pageNumber)
    if (list) list.push(question)
    else byPage.set(question.pageNumber, [question])
  }

  for (const [pageNumber, page] of byPage) byPage.set(pageNumber, sortWithinPage(page))

  let expected: number | null = null
  if (options.expectedChoiceCount !== undefined && options.expectedChoiceCount !== null) {
    expected = options.expectedChoiceCount
  }

  const pageNumbers = Array.from(byPage.keys())
  pageNumbers.sort(function (a, b) {
    return a - b
  })

  const joins: SplitJoin[] = []

  for (const pageNumber of pageNumbers) {
    const current = byPage.get(pageNumber)
    if (!current || current.length === 0) continue

    const next = byPage.get(pageNumber + 1)
    if (!next || next.length === 0) continue

    const head = current[current.length - 1]
    const tail = next[0]

    if (!CHOICE_BEARING.has(head.questionType)) continue
    if (head.choices.length > 0) continue
    if (!asksSomething(head)) continue

    if (tail.choices.length < 2) continue
    if (!asksNothing(tail)) continue

    if (expected !== null && tail.choices.length !== expected) continue

    if (
      head.printedNumber !== null &&
      tail.printedNumber !== null &&
      head.printedNumber !== tail.printedNumber
    ) {
      continue
    }

    let printedNumber = head.printedNumber
    if (printedNumber === null) printedNumber = tail.printedNumber

    let shown = '?'
    if (head.printedNumber !== null) shown = String(head.printedNumber)

    joins.push({
      keepId: head.id,
      dropId: tail.id,
      printedNumber: printedNumber,
      reason:
        'question ' + shown + ' runs from page ' + pageNumber + ' to page ' +
        (pageNumber + 1) + ': ' + tail.choices.length + ' option(s) rejoined',
    })
  }

  return joins
}
