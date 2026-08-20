'use client'
import PageHead from '@/components/page-head'

import { useId, useState } from 'react'

import { AccuracyLabel, Meter } from '@/components/meter'
import type { AccountAccuracy } from '@/lib/dashboard/queries'
import { fetchJson } from '@/lib/client/fetch-json'

interface Props {
  name: string | null
  username: string | null
  email: string
  image: string | null
  memberSince: string
  worksheetsUploaded: number
  accuracy: AccountAccuracy
  streak: number
}

function initialsOf(source: string): string {
  const words = source.trim().split(/\s+/).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return source.trim().slice(0, 2).toUpperCase()
}

function Avatar({
  name,
  username,
  email,
  image,
}: {
  name: string | null
  username: string | null
  email: string
  image: string | null
}) {
  if (image) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={image}
        alt=""
        width={64}
        height={64}
        className="h-16 w-16 rounded-full object-cover"
      />
    )
  }

  const initials = initialsOf(name || username || email)

  return (
    <div
      aria-hidden="true"
      className="flex h-16 w-16 items-center justify-center rounded-full bg-tint-lavender text-lg font-semibold text-fg"
    >
      {initials}
    </div>
  )
}

export default function ProfileClient({
  name,
  username,
  email,
  image,
  memberSince,
  worksheetsUploaded,
  accuracy,
  streak,
}: Props) {
  const nameId = useId()
  const usernameId = useId()

  const [nameValue, setNameValue] = useState(name ?? '')
  const [usernameValue, setUsernameValue] = useState(username ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function save() {
    setBusy(true)
    setError(null)
    setSaved(false)

    try {
      const response = await fetchJson('/api/account/identity', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: nameValue.trim() || null,
          username: usernameValue.trim() || null,
        }),
      })

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? 'Could not save your profile.')
      }

      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your profile.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
      <PageHead
        title="Profile"
        lede="Your display name, username and picture, and what you have got through."
      />

      {/*
        No "Identity" heading here any more. It sat directly under an h1
        reading "Profile" and named the same thing a second time; the section
        is the page's main content, so the h1 is its label.
      */}
      <div className="card mt-6 p-4">
        <div className="flex items-center gap-4">
          <Avatar name={nameValue} username={usernameValue} email={email} image={image} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {nameValue || usernameValue || email}
            </p>
            <p className="hint truncate">{email}</p>
            <p className="hint">Member since {memberSince}</p>
          </div>
        </div>

        <div className="mt-5 space-y-4">
          <div>
            <label htmlFor={nameId} className="label">
              Name
            </label>
            <input
              id={nameId}
              type="text"
              value={nameValue}
              onChange={(event) => setNameValue(event.target.value)}
              maxLength={80}
              placeholder="How your name shows up around the app"
              className="field"
            />
          </div>

          <div>
            <label htmlFor={usernameId} className="label">
              Username
            </label>
            <input
              id={usernameId}
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={usernameValue}
              onChange={(event) => setUsernameValue(event.target.value)}
              maxLength={20}
              placeholder="A handle, not a login"
              className="field"
            />
            <p className="hint text-pretty">
              Letters, numbers and underscores, starting with a letter. Sign-in stays
              email or Google either way.
            </p>
          </div>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          {saved && !error && (
            <p role="status" className="text-sm text-success">
              Saved.
            </p>
          )}

          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="btn btn-primary sm:w-auto sm:px-6"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <section aria-labelledby="stats-heading" className="card mt-6 p-4">
        <h2 id="stats-heading" className="text-sm font-medium">
          Your record
        </h2>

        <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-sm text-muted">Worksheets</dt>
            <dd className="mt-1 text-2xl font-extrabold tabular-nums text-fg">
              {worksheetsUploaded}
            </dd>
          </div>

          <div>
            <dt className="text-sm text-muted">Study streak</dt>
            <dd className="mt-1 text-2xl font-extrabold tabular-nums text-fg">
              {streak > 0 ? `${streak} day${streak === 1 ? '' : 's'}` : '—'}
            </dd>
          </div>

          <div className="col-span-2 sm:col-span-1">
            <dt className="text-sm text-muted">Overall accuracy</dt>
            <dd className="mt-1">
              <AccuracyLabel
                accuracy={accuracy.accuracy}
                ranked={accuracy.ranked}
                attempts={accuracy.attempts}
              />
            </dd>
          </div>
        </dl>

        {accuracy.ranked && (
          <div className="mt-4">
            <Meter accuracy={accuracy.accuracy} label="Overall accuracy" />
          </div>
        )}
      </section>
    </main>
  )
}
