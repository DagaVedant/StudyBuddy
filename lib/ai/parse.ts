import { ESCAPE_COLLIDING_COMMANDS } from '@/lib/questions/shape'

import {
  canReview,
  parseClassification,
  parseExplanation,
  parseExtraction,
  parseLesson,
  parsePractice,
  parseSolution,
  parseReview,
  type AIProvider,
  type QuestionReviewer,
  type RawAIProvider,
} from './types'

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

export function validated<T extends RawAIProvider>(
  provider: T,
): T extends { reviewQuestions: unknown } ? AIProvider & QuestionReviewer : AIProvider {
  const wrapped: AIProvider = {
    name: provider.name,
    model: provider.model,
    answeringModel: provider.answeringModel,
    supportsVision: provider.supportsVision,
    executionSite: provider.executionSite,

    async extractQuestions(page) {
      const { questions, rejected, rejections } = parseExtraction(
        await provider.extractQuestions(page),
      )

      if (rejected > 0) {
        const onOperatorMachine = provider.executionSite === 'operator_gpu'

        console.warn(
          `[ai] ${provider.name} page ${page.pageNumber}: dropped ${rejected} ` +
            `unreadable question(s), kept ${questions.length}`,
        )
        for (const rejection of rejections) {
          console.warn(
            `  - ${rejection.path}: ${rejection.message}` +
              (onOperatorMachine ? '' : ` :: ${rejection.preview}`),
          )
        }
      }

      return questions
    },

    async classifyTopic(promptText, candidates) {
      return parseClassification(await provider.classifyTopic(promptText, candidates))
    },

    async answerQuestion(input) {
      return parseSolution(await provider.answerQuestion(input))
    },

    async teachTopic(input) {
      return parseLesson(await provider.teachTopic(input))
    },

    async writePractice(input) {
      return parsePractice(await provider.writePractice(input))
    },

    async explain(input) {
      return parseExplanation(await provider.explain(input))
    },
  }

  if (canReview(provider)) {
    const reviewing: AIProvider & QuestionReviewer = {
      ...wrapped,
      reviewQuestions: async (candidates) =>
        parseReview(await provider.reviewQuestions(candidates)),
    }

    return reviewing as ReturnType<typeof validated<T>>
  }

  return wrapped as ReturnType<typeof validated<T>>
}
