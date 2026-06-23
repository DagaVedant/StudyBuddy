'use client'

import { useRouter } from 'next/navigation'
import { useId, useState } from 'react'

interface Credential {
  provider: string
  keyLast4: string | null
  ollamaBaseUrl: string | null
  visionModelName: string | null
}

interface Props {
  credentials: Credential[]
  trial: { pagesRemaining: number; explanationsRemaining: number }
  workerOnline: boolean
  appUrl: string
}

export default function SettingsClient({
  credentials,
  trial,
  workerOnline,
  appUrl,
}: Props) {
  const router = useRouter()
  const cloudId = useId()
  const providerId = useId()
  const ollamaId = useId()

  const [provider, setProvider] = useState<'anthropic' | 'openai'>('anthropic')
  const [apiKey, setApiKey] = useState('')
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const cloud = credentials.find(
    (row) => row.provider === 'anthropic' || row.provider === 'openai',
  )
  const ollama = credentials.find((row) => row.provider === 'ollama')

  async function save(body: unknown) {
    setBusy(true)
    setError(null)
    setNotice(null)

    try {
      const response = await fetch('/api/settings/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const result = (await response.json()) as { error?: string }
      if (!response.ok) throw new Error(result.error ?? 'Could not save that.')

      setApiKey('')
      setNotice('Saved.')
      router.refresh()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove(target: string) {
    setBusy(true)
    setError(null)
    await fetch(`/api/settings/credentials?provider=${target}`, { method: 'DELETE' })
    setNotice('Removed.')
    setBusy(false)
    router.refresh()
  }

  return (
    <div className="space-y-6">
      {error && (
        <p role="alert" className="rounded border border-danger/40 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded border border-border bg-surface px-3 py-2 text-sm">
          {notice}
        </p>
      )}

      {/* ---------------------------------------------------------------- */}
      <section
        aria-labelledby="trial-heading"
        className="rounded border border-border bg-surface p-4"
      >
        <h2 id="trial-heading" className="text-sm font-medium">
          Free trial
        </h2>
        <p className="hint text-pretty">
          <span className="tabular-nums">{trial.pagesRemaining}</span> pages and{' '}
          <span className="tabular-nums">{trial.explanationsRemaining}</span>{' '}
          explanations left. This is a one-time allowance, not monthly.
        </p>
        <p className="hint text-pretty">
          Trial uploads are processed on hardware we operate. Pages are sent
          there, kept only while the job runs, and never used for training.
          {!workerOnline &&
            ' That machine is offline right now — uploads will queue and you will be notified when they finish.'}
        </p>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section
        aria-labelledby="cloud-heading"
        className="rounded border border-border bg-surface p-4"
      >
        <h2 id="cloud-heading" className="text-sm font-medium">
          Your own API key
        </h2>
        <p className="hint text-pretty">
          Best extraction quality. You pay your provider directly; we never see
          the key again after you save it.
        </p>

        {cloud ? (
          <div className="mt-3 flex items-center gap-3">
            <span className="flex-1 truncate rounded border border-border px-3 py-2 text-sm">
              {cloud.provider} · key ending {cloud.keyLast4}
            </span>
            <button
              type="button"
              className="rounded px-2 py-1 text-sm text-muted underline underline-offset-2 hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              disabled={busy}
              onClick={() => void remove(cloud.provider)}
            >
              Remove
            </button>
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            <div>
              <label className="label" htmlFor={providerId}>
                Provider
              </label>
              <select
                id={providerId}
                className="field bg-surface text-fg"
                value={provider}
                onChange={(event) =>
                  setProvider(event.target.value as 'anthropic' | 'openai')
                }
              >
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
              </select>
            </div>

            <div>
              <label className="label" htmlFor={cloudId}>
                API key
              </label>
              <input
                id={cloudId}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-…"
                className="field"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </div>

            <button
              type="button"
              className="btn btn-primary sm:w-auto sm:px-6"
              disabled={busy || apiKey.trim().length < 10}
              onClick={() => void save({ provider, apiKey })}
            >
              {busy ? 'Saving…' : 'Save Key'}
            </button>
          </div>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      <section
        aria-labelledby="ollama-heading"
        className="rounded border border-border bg-surface p-4"
      >
        <h2 id="ollama-heading" className="text-sm font-medium">
          Your own GPU (Ollama){' '}
          <span className="ml-1 rounded border border-border px-1.5 py-0.5 text-xs font-normal text-muted">
            Not ready yet
          </span>
        </h2>
        <p className="hint text-pretty">
          Free and private — pages would never leave your machine. Our server
          cannot reach your computer, so this has to run in your browser, and
          that part is still being built. You can save your settings now;
          uploads keep using the options above until it ships.
        </p>

        {ollama ? (
          <div className="mt-3 flex items-center gap-3">
            <span className="min-w-0 flex-1 truncate rounded border border-border px-3 py-2 text-sm">
              {ollama.ollamaBaseUrl} · {ollama.visionModelName}
            </span>
            <button
              type="button"
              className="rounded px-2 py-1 text-sm text-muted underline underline-offset-2 hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              disabled={busy}
              onClick={() => void remove('ollama')}
            >
              Remove
            </button>
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            <div>
              <label className="label" htmlFor={ollamaId}>
                Ollama address
              </label>
              <input
                id={ollamaId}
                type="text"
                autoComplete="off"
                spellCheck={false}
                className="field"
                value={ollamaUrl}
                onChange={(event) => setOllamaUrl(event.target.value)}
              />
              <p className="hint">Must be localhost — that is all your browser can reach.</p>
            </div>

            <details className="text-sm">
              <summary className="cursor-pointer text-muted">
                Ollama needs permission to talk to this site
              </summary>
              <p className="hint text-pretty">
                Set <code>OLLAMA_ORIGINS</code> to <code>{appUrl}</code> and restart
                Ollama. On Windows:
              </p>
              <pre className="mt-2 overflow-x-auto rounded border border-border p-2 text-xs">
                <code>{`setx OLLAMA_ORIGINS "${appUrl}"`}</code>
              </pre>
            </details>

            <button
              type="button"
              className="btn btn-primary sm:w-auto sm:px-6"
              disabled={busy}
              onClick={() =>
                void save({
                  provider: 'ollama',
                  baseUrl: ollamaUrl,
                  visionModel: 'qwen2.5vl:7b',
                  textModel: 'qwen2.5vl:7b',
                })
              }
            >
              {busy ? 'Saving…' : 'Connect Ollama'}
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
