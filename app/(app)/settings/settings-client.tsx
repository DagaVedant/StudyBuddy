'use client'

import {useId, useRef, useState} from 'react'
import {useRouter} from 'next/navigation'

import {fetchJson} from '@/lib/client/http'
import {
  CLOUD_PROVIDERS,
  DEFAULT_CLOUD_MODEL,
  PROVIDER_COPY,
  type CloudProvider,
} from '@/lib/ai/types'

type Credential = {
  provider: string
  keyLast4: string | null
  visionModelName: string | null
  verified: boolean
}

type Props = {
  showCloud: boolean
  trialOnCloud: boolean
  credentials: Credential[]
  trial: {worksheetsRemaining: number; explanationsRemaining: number}
}

export default function SettingsClient({
  credentials,
  trial,
  showCloud,
  trialOnCloud,
}: Props) {
  let afterTrial =
    'When it is used up nothing changes except the reading: you add questions yourself.'
  if (showCloud) {
    afterTrial =
      'When it is used up nothing changes except the reading: you add questions ' +
      'yourself, or connect your own provider below and there is no cap at all.'
  }

  let whereTrialRuns =
    'Nothing is set up to read trial uploads on this deployment right now, so ' +
    'they are not read for you. You can still add questions by hand.'
  if (trialOnCloud) {
    whereTrialRuns =
      'Trial uploads are read by a hosted model on its provider\'s free tier. Pages ' +
      'are kept only while the job runs. That provider may use them to improve its ' +
      'own models.'
    if (showCloud) whereTrialRuns = whereTrialRuns + ' Your own provider below does not.'
  }

  const router = useRouter()
  const cloudId = useId()
  const providerId = useId()
  const modelId = useId()

  const [provider, setProvider] = useState<CloudProvider>('anthropic')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [justSaved, setJustSaved] = useState<Credential | null>(null)

  let cloud = justSaved

  if (!cloud) {
    for (const row of credentials) {
      if ((CLOUD_PROVIDERS as readonly string[]).includes(row.provider)) {
        cloud = row
        break
      }
    }
  }

  async function save(body: unknown) {
    setBusy(true)
    setError(null)
    setNotice(null)

    try {
      const response = await fetchJson('/api/settings/credentials', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
      })
      const result = (await response.json()) as {
        error?: string
        last4?: string
        verified?: boolean
        message?: string
      }
      if (!response.ok) {
        let message = 'Could not save that.'
        if (result.error) message = result.error

        throw new Error(message)
      }

      setApiKey('')

      let notice = 'Saved.'
      if (result.message) notice = result.message

      setNotice(notice)

      if (result.last4) {
        let verified = false
        if (result.verified) verified = true

        setJustSaved({
          provider,
          keyLast4: result.last4,
          visionModelName: model || null,
          verified: verified,
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
    setNotice(null)

    try {
      const response = await fetchJson(
        '/api/settings/credentials?provider=' + target,
        {method: 'DELETE'},
      )

      if (!response.ok) {
        let message = 'Could not remove that.'

        try {
          const detail = (await response.json()) as {error?: string}
          if (detail.error) message = detail.error
        } catch {
          message = 'Could not remove that.'
        }

        throw new Error(message)
      }

      setJustSaved(null)
      setNotice('Removed.')
      router.refresh()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
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

      <section aria-labelledby="trial-heading">
        <h2 id="trial-heading" className="mb-4 border-b border-fg/20 pb-2 text-sm font-medium">
          Free trial
        </h2>
        <p className="hint text-pretty">
          <span className="tabular-nums">{trial.worksheetsRemaining}</span>{' '}
          {trial.worksheetsRemaining === 1 ? 'worksheet' : 'worksheets'} and{' '}
          <span className="tabular-nums">{trial.explanationsRemaining}</span>{' '}
          explanations left. This is a one-time allowance, not monthly. A
          worksheet counts once no matter how many pages are in it.{' '}
          {afterTrial}
        </p>
        <p className="hint text-pretty">
          {whereTrialRuns}
        </p>
      </section>

      {showCloud && (
      <section aria-labelledby="cloud-heading">
        <h2 id="cloud-heading" className="mb-4 border-b border-fg/20 pb-2 text-sm font-medium">
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
              {!cloud.verified && (
                <span className="text-caution"> · not checked yet</span>
              )}
            </span>
            <button
              type="button"
              className="rounded px-2 py-1 text-sm text-muted hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
                void save({provider, apiKey, model: model.trim() || null})
              }
            >
              {busy ? 'Saving…' : 'Save key'}
            </button>
          </div>
        )}
      </section>
      )}

    </div>
  )
}

export function DeleteAccount({email}: {email: string}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const confirmId = useId()

  const [typed, setTyped] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const matches = typed.trim().toLowerCase() === email.toLowerCase()

  function openDialog() {
    const dialog = dialogRef.current
    if (dialog) dialog.showModal()
  }

  function closeDialog() {
    const dialog = dialogRef.current
    if (dialog) dialog.close()
  }

  async function remove() {
    setDeleting(true)
    setError(null)

    try {
      const response = await fetchJson('/api/account', {
        method: 'DELETE',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({email: typed.trim()}),
      })

      if (!response.ok) {
        let message = 'Could not delete the account'

        try {
          const detail = (await response.json()) as {error?: string}
          if (detail.error) message = detail.error
        } catch {
          message = 'Could not delete the account'
        }

        throw new Error(message)
      }

      window.location.href = '/'
    } catch (cause) {
      setDeleting(false)
      setError(cause instanceof Error ? cause.message : 'Could not delete the account')
    }
  }

  return (
    <section aria-labelledby="danger-heading" className="mt-8">
      <h2 id="danger-heading" className="mb-4 border-b border-fg/20 pb-2 text-sm font-medium">
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
          openDialog()
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
            onClick={() => closeDialog()}
          >
            Keep my account
          </button>
        </div>
      </dialog>
    </section>
  )
}
