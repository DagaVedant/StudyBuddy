export const MIN_ATTEMPTS = 5

const Z = 1.96

/**
 * Which way a topic's accuracy has moved, comparing the later half of its
 * attempts against the earlier half. Null when there is not enough to say,
 * which is different from 'flat': flat claims steadiness, null claims nothing.
 */
export type TopicTrend = 'up' | 'down' | 'flat' | null

export interface TopicStats {
  topicId: string
  topicName: string
  topicPath: string
  subjectRoot: string
  correct: number
  unsure: number
  wrong: number
  trend: TopicTrend
}

export interface RankedTopic extends TopicStats {
  attempts: number
  accuracy: number
  errorRate: number
  unsureRate: number
  score: number
  ranked: boolean
}

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
    accuracy: attempts > 0 ? stats.correct / attempts : 0,
    errorRate: attempts > 0 ? errors / attempts : 0,
    unsureRate: attempts > 0 ? stats.unsure / attempts : 0,
    score: wilsonLowerBound(errors, attempts),
    ranked: attempts >= MIN_ATTEMPTS,
  }
}

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
      // A rolled-up row has no trend of its own. Trends are computed per topic
      // from that topic's own attempts in time order, and there is no honest
      // way to add two of them together: a subject whose two topics moved in
      // opposite directions has not moved, and saying so would be a claim the
      // numbers underneath do not support.
      trend: null,
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
