const UNREACHABLE = /failed to fetch|networkerror|load failed|network request failed/i

/*
 * A browser reports every refused, blocked or unanswered request as one word:
 * "Failed to fetch". For Tier C that single message covers Ollama not running,
 * Ollama running but not told to accept this site, and a wrong address, which
 * are three different things for the student to do.
 *
 * The settings screen already explains this when its connection test fails.
 * This is the same explanation for the paths that run in the background, which
 * is where a student is more likely to meet it and less likely to know why.
 */
export function explainOllamaFailure(cause: unknown, baseUrl: string): string {
  const message = cause instanceof Error ? cause.message : String(cause)

  if (!UNREACHABLE.test(message)) return message

  const origin = typeof window === 'undefined' ? 'this site' : window.location.origin

  return (
    `Your browser could not reach Ollama at ${baseUrl}. Either it is not ` +
    `running, or it has not been told to accept requests from ${origin}: set ` +
    `OLLAMA_ORIGINS to ${origin} and restart Ollama. Settings has the exact ` +
    `command and a connection test.`
  )
}
