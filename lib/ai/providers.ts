/**
 * The catalogue of key-based providers, with no database imports so the
 * settings screen can render it without pulling the schema into the browser
 * bundle. Resolution logic lives in ./resolve.
 */

/** Providers reached with a key the student pastes in, as opposed to Ollama. */
export const CLOUD_PROVIDERS = ['anthropic', 'openai', 'openrouter', 'google'] as const

export type CloudProvider = (typeof CLOUD_PROVIDERS)[number]

export function isCloudProvider(value: string): value is CloudProvider {
  return (CLOUD_PROVIDERS as readonly string[]).includes(value)
}

/**
 * Default model per service — each the current cheap-but-vision-capable
 * option, since extraction sends an image for every page and the bill is the
 * student's own. A stored choice always wins over these.
 */
export const DEFAULT_CLOUD_MODEL: Record<CloudProvider, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-4.1',
  openrouter: 'google/gemini-2.5-flash',
  google: 'gemini-2.5-flash',
}

export interface ProviderCopy {
  label: string
  /** Where to get a key. Shown as plain text, not a link we control. */
  keysAt: string
  keyPlaceholder: string
  note: string
}

export const PROVIDER_COPY: Record<CloudProvider, ProviderCopy> = {
  anthropic: {
    label: 'Anthropic',
    keysAt: 'console.anthropic.com',
    keyPlaceholder: 'sk-ant-…',
    note: 'Claude models.',
  },
  openai: {
    label: 'OpenAI',
    keysAt: 'platform.openai.com',
    keyPlaceholder: 'sk-…',
    note: 'GPT models.',
  },
  openrouter: {
    label: 'OpenRouter',
    keysAt: 'openrouter.ai/keys',
    keyPlaceholder: 'sk-or-…',
    note: 'One key reaches Claude, GPT, Gemini and open models. Pick any of them in the model box.',
  },
  google: {
    label: 'Google Gemini',
    keysAt: 'aistudio.google.com/apikey',
    keyPlaceholder: 'AIza…',
    note: 'Gemini models. Has a free tier worth starting on.',
  },
}
