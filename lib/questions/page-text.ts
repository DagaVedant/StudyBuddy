const QUESTION_START = /^[ \t]*\(?(\d{1,3})[.)]?[ \t]+(?=[A-Z(])(.{12,})$/gm
const PROSE = /[a-z]{3,}/g

function looksLikeQuestion(line: string): boolean {
  return (line.match(PROSE) ?? []).length >= 3
}

export interface QuestionStart {
  
  number: number
  
  at: number
  
  bodyFrom: number
}

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

export function firstQuestionAt(text: string): number {
  return questionStartsOn(text)[0]?.at ?? text.length
}

export function questionNumbersOn(text: string): number[] {
  return questionStartsOn(text).map((start) => start.number)
}

export function countQuestionStarts(text: string): number {
  return questionNumbersOn(text).length
}

const SEAM_CHARS = 1200

export function tailOf(text: string, limit = SEAM_CHARS): string {
  if (text.length <= limit) return text.trim()

  const cut = text.slice(text.length - limit)
  const firstBreak = cut.indexOf('\n')
  return (firstBreak === -1 ? cut : cut.slice(firstBreak + 1)).trim()
}

export function headOf(text: string, limit = SEAM_CHARS): string {
  if (text.length <= limit) return text.trim()

  const cut = text.slice(0, limit)
  const lastBreak = cut.lastIndexOf('\n')
  return (lastBreak === -1 ? cut : cut.slice(0, lastBreak)).trim()
}

export function seamAround(
  pages: readonly { ocrText?: string | null }[],
  index: number,
): { before: string; after: string } {
  return {
    before: tailOf(pages[index - 1]?.ocrText ?? ''),
    after: headOf(pages[index + 1]?.ocrText ?? ''),
  }
}

export interface PagePosition {
  printedNumber: number | null
  
  top: number | null
  
  position: number
}

export function sortWithinPage<T extends PagePosition>(page: T[]): T[] {
  const numbered = page.every((question) => question.printedNumber !== null)
  const geometric = page.every((question) => question.top !== null)

  const key = (question: T): number =>
    numbered
      ? (question.printedNumber as number)
      : geometric
        ? (question.top as number)
        : question.position

  
  
  return [...page].sort((a, b) => key(a) - key(b) || a.position - b.position)
}
