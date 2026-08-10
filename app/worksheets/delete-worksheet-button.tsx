'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { fetchJson } from '@/lib/client/fetch-json'

interface Props {
  worksheetId: string
  title: string
}

export default function DeleteWorksheetButton({ worksheetId, title }: Props) {
  const router = useRouter()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleDelete() {
    setDeleting(true)
    setError(null)

    try {
      const response = await fetchJson(`/api/worksheets/${worksheetId}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('Could not delete')
      dialogRef.current?.close()
      router.refresh()
    } catch {
      setDeleting(false)
      setError('Could not delete. Try again.')
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label={`Delete ${title}`}
        className="rounded px-1.5 py-1 text-xs text-muted hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        onClick={() => dialogRef.current?.showModal()}
      >
        Delete
      </button>

      <dialog
        ref={dialogRef}
        className="card fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-sm p-6 text-fg backdrop:bg-black/50"
        onClose={() => setError(null)}
        onClick={(event) => {
          if (event.target === dialogRef.current) dialogRef.current?.close()
        }}
      >
        <div className="text-center">
          <p aria-hidden="true" className="text-3xl">
            🗑️
          </p>
          <h2 className="mt-2 text-lg font-semibold tracking-tight">
            Delete this worksheet?
          </h2>
          <p className="hint mt-1 text-pretty">
            <span className="font-medium text-fg">{title}</span> and everything tracked
            from it will be gone for good.
          </p>
        </div>

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
            disabled={deleting}
            onClick={() => void handleDelete()}
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
          <button
            type="button"
            autoFocus
            className="btn btn-secondary touch-manipulation sm:w-auto sm:px-6"
            disabled={deleting}
            onClick={() => dialogRef.current?.close()}
          >
            Cancel
          </button>
        </div>
      </dialog>
    </>
  )
}
