import {
  parseClassification,
  parseExplanation,
  parseExtraction,
  parseReview,
  type AIProvider,
  type RawAIProvider,
} from './types'

/**
 * Wraps a provider so its replies are checked before anyone reads them.
 *
 * This is the single place a model's output becomes trusted. It used to happen
 * inside each provider, which meant it happened four times out of five: the
 * interface promised `ExtractedQuestion[]` and the mock returned whatever it
 * liked, because a type cannot make a promise a class does not keep. Moving it
 * here makes the guarantee structural: a `RawAIProvider` returns `unknown`,
 * and the only way to reach an `AIProvider` is through this function.
 *
 * Resolve every provider through here, including in scripts. A provider that
 * skips it is not a faster provider; it is an unchecked one.
 */
export function validated(provider: RawAIProvider): AIProvider {
  const wrapped: AIProvider = {
    name: provider.name,
    supportsVision: provider.supportsVision,
    executionSite: provider.executionSite,

    async extractQuestions(page) {
      const { questions, rejected } = parseExtraction(await provider.extractQuestions(page))

      // Worth saying out loud. A page that returns eight questions and keeps
      // five is a page the student is about to see half of, and the count is
      // the only trace the rejected three ever leave.
      if (rejected > 0) {
        console.warn(
          `[ai] ${provider.name} page ${page.pageNumber}: dropped ${rejected} ` +
            `unreadable question(s), kept ${questions.length}`,
        )
      }

      return questions
    },

    async classifyTopic(promptText, candidates) {
      return parseClassification(await provider.classifyTopic(promptText, candidates))
    },

    async explain(input) {
      return parseExplanation(await provider.explain(input))
    },
  }

  // Left off entirely rather than defined-and-empty, because callers test for
  // the method to decide whether a second opinion is available at all.
  if (provider.reviewQuestions) {
    wrapped.reviewQuestions = async (candidates) =>
      parseReview(await provider.reviewQuestions!(candidates))
  }

  return wrapped
}
