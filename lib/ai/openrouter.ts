import { OpenAIProvider } from './openai'

/**
 * Tier B via OpenRouter.
 *
 * OpenRouter speaks the Chat Completions protocol, so this is the OpenAI
 * client pointed elsewhere rather than a second implementation — the request
 * shape, structured output, and error handling are identical by construction.
 *
 * The value to a student is the model list: one key reaches Claude, GPT,
 * Gemini and open models, so they are not tied to whichever vendor they
 * happened to sign up with.
 */
export class OpenRouterProvider extends OpenAIProvider {
  constructor(
    apiKey: string,
    model = 'google/gemini-2.5-flash',
    appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
    fetchImpl: typeof fetch = fetch,
  ) {
    super(apiKey, model, {
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      label: 'OpenRouter',
      name: 'openrouter',
      fetchImpl,
      // OpenRouter attributes requests to an app with these; they are optional
      // but leaving them off makes traffic look anonymous on their dashboard.
      headers: { 'HTTP-Referer': appUrl, 'X-Title': 'StudyBuddy' },
    })
  }
}
