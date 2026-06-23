/**
 * Tolerant JSON parsing for model replies.
 *
 * A local model can stop mid-string when it hits its output cap. Strict
 * JSON.parse then throws and the entire page is lost — including the twenty
 * questions it had already emitted correctly. Salvaging the complete objects
 * turns a total loss into a partial one, and the extraction review step is
 * there to catch what is missing.
 */

/**
 * Walks a truncated JSON object and closes it after the last complete entry of
 * its first array property. String state is tracked so braces inside question
 * text don't corrupt the depth count.
 */
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
      // Depth 0 inside the array means one entry just closed cleanly.
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
