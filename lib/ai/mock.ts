import {
  ProviderUnavailable,
  type AIProvider,
  type Classification,
  type ExplainInput,
  type ExtractedQuestion,
  type Explanation,
  type PageInput,
  type TopicCandidate,
} from './types'

/**
 * Deterministic stand-in provider (ENABLE_MOCK_AI). Makes every tier clickable
 * without a key, a GPU, or a worker running, and is what the automated tests
 * exercise so the pipeline can be verified without network access.
 */
export class MockProvider implements AIProvider {
  readonly name = 'mock' as const
  readonly supportsVision = true
  readonly executionSite = 'server' as const

  async extractQuestions(page: PageInput): Promise<ExtractedQuestion[]> {
    // Derive from the page text so tests can assert on real inputs rather than
    // on a fixed fixture that would pass even if nothing was wired up.
    const lines = page.text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^\s*\d+[.)]\s+/.test(line))
      .slice(0, 40)

    if (lines.length === 0) {
      return [
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
      ]
    }

    return lines.map((line, index) => ({
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
    }))
  }

  async classifyTopic(
    promptText: string,
    candidates: TopicCandidate[],
  ): Promise<Classification> {
    if (candidates.length === 0) {
      return {
        topic_slug: null,
        confidence: 0,
        abstain: true,
        suggested_name: 'Unsorted',
      }
    }

    // Crude word-overlap match — deterministic, and good enough that tests can
    // assert the *right* candidate comes back rather than just any candidate.
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

  async explain(input: ExplainInput): Promise<Explanation> {
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

/** Tier A. Every method throws so callers route to the manual flow (spec §3.5). */
export class NullProvider implements AIProvider {
  readonly name = 'null' as const
  readonly supportsVision = false
  readonly executionSite = 'server' as const

  // Parameters are kept so the signatures match AIProvider exactly; callers
  // shouldn't have to special-case this implementation.
  async extractQuestions(_page: PageInput): Promise<ExtractedQuestion[]> {
    throw new ProviderUnavailable()
  }

  async classifyTopic(
    _promptText: string,
    _candidates: TopicCandidate[],
  ): Promise<Classification> {
    throw new ProviderUnavailable()
  }

  async explain(_input: ExplainInput): Promise<Explanation> {
    throw new ProviderUnavailable()
  }
}
