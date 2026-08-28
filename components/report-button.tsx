'use client'

import {useState} from 'react'

import {fetchJson} from '@/lib/client/http'

type Target = {
  kind: string
  worksheetId?: string
  questionId?: string
}

export function ReportButton({
  target,
  label,
  placeholder,
}: {
  target: Target
  label: string
  placeholder: string
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
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({...target, message}),
      })

      if (!response.ok) {
        let problem = 'That did not send.'

        try {
          const body = (await response.json()) as {error?: string}
          if (body.error) problem = body.error
        } catch {
          problem = 'That did not send.'
        }

        throw new Error(problem)
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
        className="text-xs text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
    )
  }

  let sendText = 'Send report'
  if (sending) sendText = 'Sending…'

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
          className="w-full rounded-xl bg-transparent px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        />
      </label>

      <div className="flex gap-2">
        <button
          type="button"
          disabled={sending}
          onClick={() => {
            send()
          }}
          className="card px-3 py-1.5 text-sm hover:border-accent hover:bg-accent/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
        >
          {sendText}
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
