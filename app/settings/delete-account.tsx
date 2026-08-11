'use client'

import { useId, useRef, useState } from 'react'

import { fetchJson } from '@/lib/client/fetch-json'

/**
 * The only irreversible control in the product.
 *
 * There was no way to delete an account at all, which for something holding a
 * student's answer history is not a missing nicety. What it takes is everything
 * the account has: worksheets, page images, every answer, and a spaced
 * repetition schedule that may be months of work.
 *
 * So the shape is deliberate. It sits behind a details element rather than in
 * the flow of the page, the dialog names what goes, and the address on the
 * account has to be typed rather than a box ticked. None of that is friction
 * for its own sake: two taps in the wrong place is a plausible way to lose a
 * term's work, and this is the one action nothing can undo.
 */
export default function DeleteAccount({ email }: { email: string }) {
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

      // A hard navigation, not `router.push`. The session cookie is gone and
      // every cached server component in the client router belongs to an
      // account that no longer exists.
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
            className="mt-4 rounded-xl border border-danger/40 px-3 py-2 text-sm text-danger"
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
