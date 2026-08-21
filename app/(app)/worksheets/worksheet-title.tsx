'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useId, useState } from 'react'

import { fetchJson } from '@/lib/client/http'

export default function WorksheetTitle({
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
