import { ESCAPE_COLLIDING_COMMANDS } from '@/lib/questions/math'

const JSON_ESCAPE_LETTERS = new Set(['b', 'f', 'n', 'r', 't', 'u'])

export function repairLatexEscapes(text: string): string {
  let out = ''
  let inString = false
  let i = 0

  while (i < text.length) {
    const char = text[i]

    if (!inString) {
      if (char === '"') inString = true
      out += char
      i += 1
      continue
    }

    if (char !== '\\') {
      if (char === '"') inString = false
      out += char
      i += 1
      continue
    }

    const run = /^[a-zA-Z]+/.exec(text.slice(i + 1))?.[0] ?? ''
    if (run && (!JSON_ESCAPE_LETTERS.has(run[0]) || ESCAPE_COLLIDING_COMMANDS.has(run))) {
      out += `\\\\${run}`
      i += 1 + run.length
      continue
    }

    out += text.slice(i, i + 2)
    i += 2
  }

  return out
}

export function salvageTruncatedJson(text: string): unknown | null {
  const arrayStart = text.indexOf('[')
  if (arrayStart === -1) return null

  let depth = 0
  let inString = false
  let escaped = false
  let lastCompleteEntry = -1

  for (let i = arrayStart + 1; i < text.length; i += 1) {
    const char = text[i]

    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) lastCompleteEntry = i
      else if (depth < 0) break
    }
  }

  if (lastCompleteEntry === -1) return null

  const rebuilt = `${text.slice(0, lastCompleteEntry + 1)}]}`

  try {
    return JSON.parse(rebuilt)
  } catch {
    return null
  }
}

export interface LenientParse {
  value: unknown
  truncated: boolean
}

export function parseModelJson(text: string): LenientParse {
  const repaired = repairLatexEscapes(text)

  try {
    return { value: JSON.parse(repaired), truncated: false }
  } catch {
    const salvaged = salvageTruncatedJson(repaired)
    if (salvaged === null) {
      throw new Error(
        `Model returned unparseable JSON (${text.length} chars) and nothing could be salvaged.`,
      )
    }
    return { value: salvaged, truncated: true }
  }
}
