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
