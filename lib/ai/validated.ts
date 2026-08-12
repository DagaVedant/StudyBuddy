import {
  canReview,
  parseClassification,
  parseExplanation,
  parseExtraction,
  parseLesson,
  parseSolution,
  parseReview,
  type AIProvider,
  type QuestionReviewer,
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
export function validated<T extends RawAIProvider>(
  provider: T,
): T extends { reviewQuestions: unknown } ? AIProvider & QuestionReviewer : AIProvider {
  const wrapped: AIProvider = {
    name: provider.name,
    model: provider.model,
    supportsVision: provider.supportsVision,
    executionSite: provider.executionSite,

    async extractQuestions(page) {
      const { questions, rejected, rejections } = parseExtraction(
        await provider.extractQuestions(page),
      )

      // Worth saying out loud. A page that returns eight questions and keeps
      // five is a page the student is about to see half of.
      //
      // With the reason, not just the count: a page losing six of its seven
      // questions used to report only the number, which cannot distinguish a
      // model returning nonsense from this schema being stricter than the
      // paper. Those are opposite problems and the fix for one makes the other
      // worse.
      if (rejected > 0) {
        console.warn(
          `[ai] ${provider.name} page ${page.pageNumber}: dropped ${rejected} ` +
            `unreadable question(s), kept ${questions.length}`,
        )
        for (const rejection of rejections) {
          console.warn(`  - ${rejection.path}: ${rejection.message} :: ${rejection.preview}`)
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

    async explain(input) {
      return parseExplanation(await provider.explain(input))
    },
  }

  // Left off entirely rather than defined-and-empty, because `canReview` tests
  // for the method to decide whether a second opinion is available at all, and
  // a stub returning [] would read as a reviewer with no opinions rather than
  // as a provider that does not review.
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
