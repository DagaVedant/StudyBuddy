import { OpenAIProvider } from './openai'

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
      headers: { 'HTTP-Referer': appUrl, 'X-Title': 'StudyBuddy' },
    })
  }
}
