'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

interface Props {
  worksheetId: string
  title: string
}

export default function DeleteWorksheetButton({ worksheetId, title }: Props) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleDelete() {
    setDeleting(true)
    setError(null)

    try {
      const response = await fetch(`/api/worksheets/${worksheetId}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('Could not delete')
      router.refresh()
    } catch {
      setDeleting(false)
      setConfirming(false)
      setError('Could not delete. Try again.')
    }
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-danger">Delete for good?</span>
        <button
          type="button"
          className="rounded px-1.5 py-1 text-xs font-medium text-danger underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
          disabled={deleting}
          onClick={() => void handleDelete()}
        >
          {deleting ? 'Deleting…' : 'Yes, delete'}
        </button>
        <button
          type="button"
          className="rounded px-1.5 py-1 text-xs text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
          disabled={deleting}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        aria-label={`Delete ${title}`}
        className="rounded px-1.5 py-1 text-xs text-muted hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        onClick={() => setConfirming(true)}
      >
        Delete
      </button>
      {error && (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
    </div>
  )
}
