'use client'

import { useState } from 'react'
import { fetchJson } from '@/lib/client/fetch-json'

type Target =
  | { kind: 'worksheet'; worksheetId: string }
  | { kind: 'explanation'; questionId: string }

export default function ReportButton({
  target,
  label = 'Report a problem',
  placeholder = 'What went wrong?',
}: {
  target: Target
  label?: string
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send() {
    setSending(true)
    setError(null)

    try {
      const response = await fetchJson('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...target, message }),
      })

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? 'That did not send.')
      }

      setSent(true)
      setOpen(false)
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setSending(false)
    }
  }

  if (sent) {
    return (
      <p aria-live="polite" className="hint">
        Thanks. That is on the list to look at.
      </p>
    )
  }

  if (!open) {
    return (
      <button
        type="button"
        className="text-xs text-muted underline underline-offset-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
    )
  }

  return (
    <div className="space-y-2">
      <label className="block">
        <span className="sr-only">{placeholder}</span>
        <textarea
          autoFocus
          rows={3}
          value={message}
          placeholder={placeholder}
          onChange={(event) => setMessage(event.target.value)}
          maxLength={2000}
          className="w-full rounded-xl border border-border bg-transparent px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        />
      </label>

      <div className="flex gap-2">
        <button
          type="button"
          disabled={sending}
          onClick={() => void send()}
          className="rounded-xl border border-border px-3 py-1.5 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
        >
          {sending ? 'Sending…' : 'Send report'}
        </button>
        <button
          type="button"
          disabled={sending}
          onClick={() => setOpen(false)}
          className="rounded-xl px-3 py-1.5 text-sm text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Cancel
        </button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
