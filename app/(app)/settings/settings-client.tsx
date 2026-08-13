'use client'

import { useRouter } from 'next/navigation'
import { useId, useState } from 'react'

import {
  CLOUD_PROVIDERS,
  DEFAULT_CLOUD_MODEL,
  PROVIDER_COPY,
  type CloudProvider,
} from '@/lib/ai/providers'
import { fetchJson } from '@/lib/client/fetch-json'

interface Credential {
  provider: string
  keyLast4: string | null
  ollamaBaseUrl: string | null
  visionModelName: string | null
}

interface Props {
  credentials: Credential[]
  trial: { worksheetsRemaining: number; explanationsRemaining: number }
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
  const modelId = useId()

  const [provider, setProvider] = useState<CloudProvider>('anthropic')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const cloud = credentials.find((row) =>
    (CLOUD_PROVIDERS as readonly string[]).includes(row.provider),
  )
  const ollama = credentials.find((row) => row.provider === 'ollama')

  async function save(body: unknown) {
    setBusy(true)
    setError(null)
    setNotice(null)

    try {
      const response = await fetchJson('/api/settings/credentials', {
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
    await fetchJson(`/api/settings/credentials?provider=${target}`, { method: 'DELETE' })
    setNotice('Removed.')
    setBusy(false)
    router.refresh()
  }

  return (
    <div className="space-y-6">
      {error && (
        <p role="alert" className="rounded-xl border border-danger/40 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-xl border border-border bg-surface px-3 py-2 text-sm">
          {notice}
        </p>
      )}

      <section
        aria-labelledby="trial-heading"
        className="card p-4"
      >
        <h2 id="trial-heading" className="text-sm font-medium">
          Free trial
        </h2>
        <p className="hint text-pretty">
          <span className="tabular-nums">{trial.worksheetsRemaining}</span>{' '}
          {trial.worksheetsRemaining === 1 ? 'worksheet' : 'worksheets'} and{' '}
          <span className="tabular-nums">{trial.explanationsRemaining}</span>{' '}
          explanations left. This is a one-time allowance, not monthly. A
          worksheet counts once no matter how many pages are in it.
        </p>
        <p className="hint text-pretty">
          Trial uploads are processed on hardware we operate. Pages are sent
          there, kept only while the job runs, and never used for training.
          {!workerOnline &&
            ' That machine is offline right now. Uploads will queue and start when it comes back.'}
        </p>
      </section>

      <section
        aria-labelledby="cloud-heading"
        className="card p-4"
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
            <span className="flex-1 truncate rounded-xl border border-border px-3 py-2 text-sm">
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
                onChange={(event) => {
                  setProvider(event.target.value as CloudProvider)
                  // The old provider's model name means nothing to the new one.
                  setModel('')
                }}
              >
                {CLOUD_PROVIDERS.map((option) => (
                  <option key={option} value={option}>
                    {PROVIDER_COPY[option].label}
                  </option>
                ))}
              </select>
              <p className="hint text-pretty">
                {PROVIDER_COPY[provider].note} Keys from{' '}
                {PROVIDER_COPY[provider].keysAt}.
              </p>
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
                placeholder={PROVIDER_COPY[provider].keyPlaceholder}
                className="field"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </div>

            <div>
              <label className="label" htmlFor={modelId}>
                Model <span className="font-normal text-muted">(optional)</span>
              </label>
              <input
                id={modelId}
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={DEFAULT_CLOUD_MODEL[provider]}
                className="field"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              />
              <p className="hint text-pretty">
                Leave blank for {DEFAULT_CLOUD_MODEL[provider]}. It has to be a
                model that can read images, or extraction will fail.
              </p>
            </div>

            <button
              type="button"
              className="btn btn-primary sm:w-auto sm:px-6"
              disabled={busy || apiKey.trim().length < 10}
              onClick={() =>
                void save({ provider, apiKey, model: model.trim() || null })
              }
            >
              {busy ? 'Saving…' : 'Save key'}
            </button>
          </div>
        )}
      </section>

      <section
        aria-labelledby="ollama-heading"
        className="card p-4"
      >
        <h2 id="ollama-heading" className="text-sm font-medium">
          Your own GPU (Ollama){' '}
          <span className="ml-1 rounded-full border border-border px-2 py-0.5 text-xs font-normal text-muted">
            Not ready yet
          </span>
        </h2>
        <p className="hint text-pretty">
          Free and private: pages would never leave your machine. Our server
          cannot reach your computer, so this has to run in your browser, and
          that part is still being built. You can save your settings now;
          uploads keep using the options above until it ships.
        </p>

        {ollama ? (
          <div className="mt-3 flex items-center gap-3">
            <span className="min-w-0 flex-1 truncate rounded-xl border border-border px-3 py-2 text-sm">
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
              <p className="hint">Must be localhost. That is all your browser can reach.</p>
            </div>

            <details className="text-sm">
              <summary className="cursor-pointer text-muted">
                Ollama needs permission to talk to this site
              </summary>
              <p className="hint text-pretty">
                Set <code>OLLAMA_ORIGINS</code> to <code>{appUrl}</code> and restart
                Ollama. On Windows:
              </p>
              <pre className="mt-2 overflow-x-auto rounded-lg border border-border p-2 text-xs">
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
