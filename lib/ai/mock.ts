import {
  ProviderUnavailable,
  type ExplainInput,
  type PageInput,
  type RawAIProvider,
  type TopicCandidate,
} from './types'

export class MockProvider implements RawAIProvider {
  readonly name = 'mock' as const
  readonly model = 'mock' as const
  readonly supportsVision = true
  readonly executionSite = 'server' as const

  async extractQuestions(page: PageInput): Promise<unknown> {

    const lines = page.text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^\s*\d+[.)]\s+/.test(line))
      .slice(0, 40)

    // Shaped like a model reply rather than like the parsed result, because
    // that is what a provider returns now: `validated` does the parsing, and
    // the mock has to go through it like everything else.
    if (lines.length === 0) {
      return {
        questions: [
          {
            ordinal: 1,
            prompt_text: `Sample question from page ${page.pageNumber}`,
            question_type: 'multiple_choice',
            choices: [
              { label: 'A', text: 'First option' },
              { label: 'B', text: 'Second option' },
            ],
            bbox: [0, 0, Math.min(page.width, 100), Math.min(page.height, 100)],
            has_figure: false,
          },
        ],
      }
    }

    return {
      questions: lines.map((line, index) => ({
        ordinal: index + 1,
        prompt_text: line.replace(/^\s*\d+[.)]\s+/, ''),
        question_type: 'multiple_choice' as const,
        choices: [
          { label: 'A', text: 'Option A' },
          { label: 'B', text: 'Option B' },
          { label: 'C', text: 'Option C' },
          { label: 'D', text: 'Option D' },
        ],
        bbox: null,
        has_figure: false,
      })),
    }
  }

  async classifyTopic(
    promptText: string,
    candidates: TopicCandidate[],
  ): Promise<unknown> {
    if (candidates.length === 0) {
      return {
        topic_slug: null,
        confidence: 0,
        abstain: true,
        suggested_name: 'Unsorted',
      }
    }

    const words = new Set(
      promptText
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 3),
    )

    let best = candidates[0]
    let bestScore = -1

    for (const candidate of candidates) {
      const score = candidate.name
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => words.has(word)).length
      if (score > bestScore) {
        best = candidate
        bestScore = score
      }
    }

    if (bestScore <= 0) {
      return {
        topic_slug: null,
        confidence: 0.1,
        abstain: true,
        suggested_name: promptText.split(/\s+/).slice(0, 3).join(' '),
      }
    }

    return {
      topic_slug: best.slug,
      confidence: Math.min(0.5 + bestScore * 0.15, 0.95),
      abstain: false,
      suggested_name: null,
    }
  }

  async explain(input: ExplainInput): Promise<unknown> {
    const chosen = input.studentAnswer
    const correct = input.correctAnswer ?? 'not recorded'

    return {
      body_md: chosen
        ? `You answered **${chosen}**, but the correct answer is **${correct}**. Work back through the question and check which step produced ${chosen} instead.`
        : `The correct answer is **${correct}**.`,
      misconception_note: chosen ? `Chose ${chosen} instead of ${correct}.` : null,
    }
  }
}

export class NullProvider implements RawAIProvider {
  readonly name = 'null' as const
  // It never generates anything, so there is no model to name. 'none' rather
  // than '' so a value that reaches a log or a column still reads as an answer.
  readonly model = 'none' as const
  readonly supportsVision = false
  readonly executionSite = 'server' as const

  async extractQuestions(_page: PageInput): Promise<unknown> {
    throw new ProviderUnavailable()
  }

  async classifyTopic(
    _promptText: string,
    _candidates: TopicCandidate[],
  ): Promise<unknown> {
    throw new ProviderUnavailable()
  }

  async explain(_input: ExplainInput): Promise<unknown> {
    throw new ProviderUnavailable()
  }
}
