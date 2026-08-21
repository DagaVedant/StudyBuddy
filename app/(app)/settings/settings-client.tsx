'use client'

import { useId, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { fetchJson } from '@/lib/client/http'

import {
  CLOUD_PROVIDERS,
  DEFAULT_CLOUD_MODEL,
  PROVIDER_COPY,
  type CloudProvider,
} from '@/lib/ai/types'

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

type ProbeResult =
  | { ok: true; models: string[]; hasVisionModel: boolean }
  | { ok: false; message: string }

const OLLAMA_VISION_MODEL = 'qwen2.5vl:7b'

async function probeOllama(baseUrl: string, appUrl: string): Promise<ProbeResult> {
  try {
    const { OllamaProvider } = await import('@/lib/ai/ollama')
    const models = await new OllamaProvider({
      baseUrl,
      visionModel: OLLAMA_VISION_MODEL,
      textModel: OLLAMA_VISION_MODEL,
    }).listModels()

    return {
      ok: true,
      models,
      hasVisionModel: models.some((name) => name.startsWith(OLLAMA_VISION_MODEL.split(':')[0])),
    }
  } catch (cause) {
    const reason = (cause as Error).message

    return {
      ok: false,
      message:
        `Could not reach Ollama at ${baseUrl} (${reason}). Check it is running, ` +
        `then check it is allowed to talk to this site: OLLAMA_ORIGINS must ` +
        `include ${appUrl}, and Ollama has to be restarted after setting it.`,
    }
  }
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
  const [probe, setProbe] = useState<ProbeResult | null>(null)

  const [justSaved, setJustSaved] = useState<Credential | null>(null)

  const cloud =
    justSaved ??
    credentials.find((row) => (CLOUD_PROVIDERS as readonly string[]).includes(row.provider))
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
      const result = (await response.json()) as { error?: string; last4?: string }
      if (!response.ok) throw new Error(result.error ?? 'Could not save that.')

      setApiKey('')
      setNotice('Saved.')

      if (result.last4) {
        setJustSaved({
          provider,
          keyLast4: result.last4,
          ollamaBaseUrl: null,
          visionModelName: model || null,
        })
      }

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
    setJustSaved(null)
    setNotice('Removed.')
    setBusy(false)
    router.refresh()
  }

  return (
    <div className="space-y-6">
      {error && (
        <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-xl bg-surface px-3 py-2 text-sm">
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
          Best extraction quality. You pay your provider directly. Your key is
          encrypted before it is stored and is never shown to you or anyone
          else again; the server decrypts it to call your provider each time it
          processes one of your worksheets.
        </p>

        {cloud ? (
          <div className="mt-3 flex items-center gap-3">
            <span className="flex-1 truncate rounded-xl px-3 py-2 text-sm">
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
                Model
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
          Your own GPU (Ollama)
        </h2>
        <p className="hint text-pretty">
          Free and private: your pages never leave your machine. Our server
          cannot reach your computer, so the reading runs in this browser
          instead. That means the tab has to stay open while a worksheet is
          being read, and it picks up from the last finished page if you close
          it.
        </p>

        {ollama ? (
          <div className="mt-3 flex items-center gap-3">
            <span className="min-w-0 flex-1 truncate rounded-xl px-3 py-2 text-sm">
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
              <pre className="mt-2 overflow-x-auto rounded-lg p-2 text-xs">
                <code>{`setx OLLAMA_ORIGINS "${appUrl}"`}</code>
              </pre>
            </details>

            {probe && (
              <p
                role="status"
                className={
                  probe.ok
                    ? 'rounded-xl  bg-surface px-3 py-2 text-sm'
                    : 'rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger'
                }
              >
                {probe.ok
                  ? probe.hasVisionModel
                    ? `Connected. ${probe.models.length} model${probe.models.length === 1 ? '' : 's'} available.`
                    : `Connected, but ${OLLAMA_VISION_MODEL} is not pulled. Run "ollama pull ${OLLAMA_VISION_MODEL}" first: it is the model that reads your pages.`
                  : probe.message}
              </p>
            )}

            <div className="flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                className="btn btn-primary sm:w-auto sm:px-6"
                disabled={busy}
                onClick={() =>
                  void save({
                    provider: 'ollama',
                    baseUrl: ollamaUrl,
                    visionModel: OLLAMA_VISION_MODEL,
                    textModel: OLLAMA_VISION_MODEL,
                  })
                }
              >
                {busy ? 'Saving…' : 'Connect Ollama'}
              </button>

              <button
                type="button"
                className="btn btn-secondary sm:w-auto sm:px-6"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  setProbe(null)
                  void probeOllama(ollamaUrl, appUrl)
                    .then(setProbe)
                    .finally(() => setBusy(false))
                }}
              >
                Test connection
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

export function DeleteAccount({ email }: { email: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const confirmId = useId()

  const [typed, setTyped] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const matches = typed.trim().toLowerCase() === email.toLowerCase()

  async function remove() {
    setDeleting(true)
    setError(null)

    try {
      const response = await fetchJson('/api/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: typed.trim() }),
      })

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? 'Could not delete the account')
      }

      window.location.href = '/'
    } catch (cause) {
      setDeleting(false)
      setError(cause instanceof Error ? cause.message : 'Could not delete the account')
    }
  }

  return (
    <section aria-labelledby="danger-heading" className="card mt-8 p-4">
      <h2 id="danger-heading" className="text-sm font-medium">
        Delete your account
      </h2>
      <p className="hint text-pretty">
        Removes your worksheets, the pages we stored for them, every answer you
        have marked, and your review schedule. This cannot be undone.
      </p>

      <button
        type="button"
        className="btn btn-secondary mt-3 text-danger sm:w-auto sm:px-6"
        onClick={() => {
          setTyped('')
          setError(null)
          dialogRef.current?.showModal()
        }}
      >
        Delete account
      </button>

      <dialog
        ref={dialogRef}
        className="card fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-md p-6 text-fg backdrop:bg-black/50"
        onClose={() => setError(null)}
      >
        <h3 className="text-lg font-semibold tracking-tight">Delete this account?</h3>
        <p className="hint mt-1 text-pretty">
          Everything goes: your worksheets and their pages, every question and
          every answer you have marked, your review schedule, and any API key you
          have saved. Nothing here can be restored afterwards.
        </p>

        <label className="label mt-4 block" htmlFor={confirmId}>
          Type <span className="font-medium text-fg">{email}</span> to confirm
        </label>
        <input
          id={confirmId}
          type="email"
          autoComplete="off"
          spellCheck={false}
          className="field"
          disabled={deleting}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            {error}
          </p>
        )}

        <div className="mt-6 flex flex-col gap-3 sm:flex-row-reverse">
          <button
            type="button"
            className="btn btn-danger touch-manipulation sm:w-auto sm:px-6"
            disabled={deleting || !matches}
            onClick={() => void remove()}
          >
            {deleting ? 'Deleting…' : 'Delete everything'}
          </button>
          <button
            type="button"
            autoFocus
            className="btn btn-secondary touch-manipulation sm:w-auto sm:px-6"
            disabled={deleting}
            onClick={() => dialogRef.current?.close()}
          >
            Keep my account
          </button>
        </div>
      </dialog>
    </section>
  )
}
