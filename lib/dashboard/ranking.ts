/**
 * Weakness ranking (spec §5.5).
 *
 * Ranking topics by raw error rate is the obvious approach and it is wrong:
 * "1 wrong out of 1" beats "12 wrong out of 40" and the dashboard confidently
 * sends the student to study something they have seen once. Two guards fix it:
 *
 *   1. a topic needs MIN_ATTEMPTS before it can be called a weakness at all
 *   2. ranking uses the Wilson score lower bound of the error rate, which
 *      penalises small samples on its own
 */

/** Below this, a topic renders as "not enough data yet" — never red, never green. */
export const MIN_ATTEMPTS = 5

/** 1.96 ≈ 95% confidence. */
const Z = 1.96

export interface TopicStats {
  topicId: string
  topicName: string
  topicPath: string
  subjectRoot: string
  correct: number
  unsure: number
  wrong: number
}

export interface RankedTopic extends TopicStats {
  attempts: number
  /** Share of attempts answered correctly and confidently. */
  accuracy: number
  errorRate: number
  unsureRate: number
  /** Ranking key: pessimistic estimate of the true error rate. */
  score: number
  /** False when the topic is below MIN_ATTEMPTS. */
  ranked: boolean
}

/**
 * Wilson score lower bound for a binomial proportion. With few observations it
 * sits far below the naive rate, which is exactly the behaviour we want.
 */
export function wilsonLowerBound(successes: number, total: number, z: number = Z): number {
  if (total <= 0) return 0

  const phat = successes / total
  const z2 = z * z
  const denominator = 1 + z2 / total
  const centre = phat + z2 / (2 * total)
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * total)) / total)

  return Math.max(0, (centre - margin) / denominator)
}

export function summarize(stats: TopicStats): RankedTopic {
  const attempts = stats.correct + stats.unsure + stats.wrong
  const errors = stats.wrong

  return {
    ...stats,
    attempts,
    // `unsure` counts as neither right nor wrong for accuracy — it gets its own
    // signal, because a high unsure rate means fragile knowledge, not strength.
    accuracy: attempts > 0 ? stats.correct / attempts : 0,
    errorRate: attempts > 0 ? errors / attempts : 0,
    unsureRate: attempts > 0 ? stats.unsure / attempts : 0,
    score: wilsonLowerBound(errors, attempts),
    ranked: attempts >= MIN_ATTEMPTS,
  }
}

/**
 * Weakest first. Topics under the attempt floor are excluded entirely — they
 * are surfaced separately as "needs more data" rather than mixed into advice.
 */
export function rankWeaknesses(stats: TopicStats[]): RankedTopic[] {
  return stats
    .map(summarize)
    .filter((topic) => topic.ranked && topic.wrong > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.errorRate - a.errorRate ||
        b.attempts - a.attempts ||
        a.topicPath.localeCompare(b.topicPath),
    )
}

/**
 * Right-but-guessed. High accuracy with a high unsure rate reads as strength
 * on any normal dashboard and is actually the most fragile state a topic can
 * be in, so it gets its own list.
 */
export function rankFragile(stats: TopicStats[]): RankedTopic[] {
  return stats
    .map(summarize)
    .filter((topic) => topic.ranked && topic.unsure > 0)
    .sort(
      (a, b) =>
        wilsonLowerBound(b.unsure, b.attempts) - wilsonLowerBound(a.unsure, a.attempts) ||
        b.unsureRate - a.unsureRate ||
        a.topicPath.localeCompare(b.topicPath),
    )
}

/** Rolls leaf-level stats up to any ancestor depth for the drilldown. */
export function rollUp(
  stats: TopicStats[],
  keyOf: (stats: TopicStats) => string,
  labelOf: (stats: TopicStats) => string,
): RankedTopic[] {
  const buckets = new Map<string, TopicStats>()

  for (const entry of stats) {
    const key = keyOf(entry)
    const bucket = buckets.get(key) ?? {
      topicId: key,
      topicName: labelOf(entry),
      topicPath: labelOf(entry),
      subjectRoot: entry.subjectRoot,
      correct: 0,
      unsure: 0,
      wrong: 0,
    }

    bucket.correct += entry.correct
    bucket.unsure += entry.unsure
    bucket.wrong += entry.wrong
    buckets.set(key, bucket)
  }

  return [...buckets.values()]
    .map(summarize)
    .sort((a, b) => a.topicPath.localeCompare(b.topicPath))
}
