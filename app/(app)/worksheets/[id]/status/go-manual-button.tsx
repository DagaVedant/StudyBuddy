'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { fetchJson } from '@/lib/client/fetch-json'

/**
 * The offline queue's way out.
 *
 * A plain `Link` was enough for the failed branch, because a failed job is
 * already in a terminal state and nothing else will touch it. This worksheet
 * is not: a job is still `pending`, and clicking through without cancelling
 * it first would let the worker claim it the moment it comes back online,
 * extracting straight into a worksheet the student has since started filling
 * in by hand. So this is a button, not a link, and it waits for the server to
 * cancel that job before it navigates anywhere.
 */
export default function GoManualButton({ worksheetId }: { worksheetId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function start() {
    setBusy(true)
    setError(null)

    try {
      const response = await fetchJson(`/api/worksheets/${worksheetId}/go-manual`, {
        method: 'POST',
      })

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? 'Could not switch to manual entry.')
      }

      const body = (await response.json()) as { next: string }
      router.push(body.next)
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'Could not switch to manual entry.')
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={start}
        disabled={busy}
        className="btn btn-secondary sm:w-auto sm:px-6"
      >
        {busy ? 'Switching…' : 'Add questions manually instead'}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
