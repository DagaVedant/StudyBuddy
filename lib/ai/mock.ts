import {
  ProviderUnavailable,
  type AnswerInput,
  type ExplainInput,
  type LessonInput,
  type PageInput,
  type RawAIProvider,
  type TopicCandidate,
} from './types'

export class MockProvider implements RawAIProvider {
  readonly name = 'mock' as const
  readonly model = 'mock' as const
  readonly answeringModel = 'mock' as const
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

  /**
   * Answers whichever option the fixture marked correct, or the first one.
   *
   * Deterministic on purpose. The e2e suite marks a paper and checks what the
   * dashboard says afterwards, so an answer that moved between runs would make
   * every downstream assertion flaky for reasons that have nothing to do with
   * what is being tested.
   */
  async answerQuestion(input: AnswerInput): Promise<unknown> {
    const answer = input.choices[0]?.label ?? '42'

    return {
      answer,
      working: `Mock working for: ${input.promptText.slice(0, 60)}`,
      traps: input.choices.slice(1).map((choice) => ({
        label: choice.label,
        why: `Mock trap for ${choice.label}.`,
      })),
      confidence: 0.9,
    }
  }

  async teachTopic(input: LessonInput): Promise<unknown> {
    return {
      body_md: `## ${input.topicName}

Mock lesson for ${input.topicPath}.`,
      examples: [
        { question: 'Mock example one', working: 'Step one.', answer: '1' },
        { question: 'Mock example two', working: 'Step one.', answer: '2' },
      ],
      common_errors: [
        { mistake: 'Mock mistake', why: 'Mock reason', fix: 'Mock fix' },
      ],
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
  readonly answeringModel = 'none' as const
  readonly supportsVision = false
  // Not 'server'. It answers nothing here or anywhere, and claiming a site is
  // what forced the one caller that needs to know to match on `name === 'null'`.
  readonly executionSite = 'none' as const

  async extractQuestions(_page: PageInput): Promise<unknown> {
    throw new ProviderUnavailable()
  }

  async classifyTopic(
    _promptText: string,
    _candidates: TopicCandidate[],
  ): Promise<unknown> {
    throw new ProviderUnavailable()
  }

  async answerQuestion(_input: AnswerInput): Promise<unknown> {
    throw new ProviderUnavailable()
  }

  async teachTopic(_input: LessonInput): Promise<unknown> {
    throw new ProviderUnavailable()
  }

  async explain(_input: ExplainInput): Promise<unknown> {
    throw new ProviderUnavailable()
  }
}
