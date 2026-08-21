'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { fetchJson } from '@/lib/client/http'

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
