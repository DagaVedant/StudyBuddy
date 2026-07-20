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
  try {
    return { value: JSON.parse(text), truncated: false }
  } catch {
    const salvaged = salvageTruncatedJson(text)
    if (salvaged === null) {
      throw new Error(
        `Model returned unparseable JSON (${text.length} chars) and nothing could be salvaged.`,
      )
    }
    return { value: salvaged, truncated: true }
  }
}
