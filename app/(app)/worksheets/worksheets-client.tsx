'use client'

import Link from 'next/link'
import { useId, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { fetchJson } from '@/lib/client/http'

export function WorksheetTitle({
  worksheetId,
  title,
  href,
}: {
  worksheetId: string
  title: string
  href: string
}) {
  const router = useRouter()
  const inputId = useId()

  const [current, setCurrent] = useState(title)
  const [draft, setDraft] = useState(title)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    const next = draft.trim()

    if (!next || next === current) {
      setEditing(false)
      setDraft(current)
      setError(null)
      return
    }

    setSaving(true)
    setError(null)

    try {
      const response = await fetchJson(`/api/worksheets/${worksheetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: next }),
      })

      const result = (await response.json()) as { error?: string; title?: string }
      if (!response.ok) throw new Error(result.error ?? 'Could not rename that.')

      setCurrent(result.title ?? next)
      setEditing(false)
      router.refresh()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (!editing) {
    return (
      <div className="flex items-start justify-between gap-2">
        <Link
          href={href}
          className="line-clamp-2 font-medium hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {current}
        </Link>
        <button
          type="button"
          aria-label={`Rename ${current}`}
          className="btn-compact shrink-0 rounded px-1.5 text-xs text-muted hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          onClick={() => {
            setDraft(current)
            setEditing(true)
          }}
        >
          Rename
        </button>
      </div>
    )
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <label className="sr-only" htmlFor={inputId}>
        Worksheet title
      </label>
      <input
        id={inputId}
        autoFocus
        type="text"
        maxLength={200}
        className="field"
        value={draft}
        disabled={saving}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setEditing(false)
            setDraft(current)
            setError(null)
          }
        }}
      />

      {error && (
        <p role="alert" className="hint text-danger">
          {error}
        </p>
      )}

      <div className="mt-2 flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="btn btn-secondary sm:w-auto sm:px-4"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          disabled={saving}
          className="btn btn-secondary sm:w-auto sm:px-4"
          onClick={() => {
            setEditing(false)
            setDraft(current)
            setError(null)
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

interface Props {
  worksheetId: string
  title: string
}

export function DeleteWorksheetButton({ worksheetId, title }: Props) {
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
