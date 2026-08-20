const UNREACHABLE = /failed to fetch|networkerror|load failed|network request failed/i

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
