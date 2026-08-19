import { describe, expect, it } from 'vitest'

import { explainOllamaFailure } from '@/lib/client/ollama-error'

const BASE = 'http://localhost:11434'

describe('explaining a failed Tier C call', () => {
  it('turns the browser one-liner into the three things it can mean', () => {
    const message = explainOllamaFailure(new TypeError('Failed to fetch'), BASE)

    expect(message).toContain(BASE)
    expect(message).toContain('OLLAMA_ORIGINS')
    expect(message).toContain('not running')
  })

  it('covers what other browsers call it', () => {
    for (const raw of ['NetworkError when attempting to fetch resource.', 'Load failed']) {
      expect(explainOllamaFailure(new TypeError(raw), BASE)).toContain('OLLAMA_ORIGINS')
    }
  })

  it('leaves a real error alone, since it already says something useful', () => {
    const message = explainOllamaFailure(new Error('Ollama responded 500'), BASE)

    expect(message).toBe('Ollama responded 500')
  })

  it('handles something thrown that is not an error at all', () => {
    expect(explainOllamaFailure('nope', BASE)).toBe('nope')
  })
})
