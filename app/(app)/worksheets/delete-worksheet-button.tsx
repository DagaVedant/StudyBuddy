'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { fetchJson } from '@/lib/client/http'

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
        className="btn-compact rounded px-1.5 text-xs text-muted hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
          <span
            aria-hidden="true"
            className="mx-auto flex size-11 items-center justify-center bg-danger/10 text-danger"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="size-5"
            >
              <path d="M4 7h16" />
              <path d="M10 11v6M14 11v6" />
              <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
              <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
            </svg>
          </span>
          <h2 className="mt-3 text-lg font-semibold tracking-tight">
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
            className="mt-4 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger"
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
