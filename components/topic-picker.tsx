'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'

export interface TopicChoice {
  id: string
  slug: string
  name: string
  path: string
}

interface Props {
  topics: TopicChoice[]
  value: string | null
  onChange: (topicId: string | null) => void
  disabled?: boolean
}

const MAX_RESULTS = 40

function score(topic: TopicChoice, query: string): number {
  const name = topic.name.toLowerCase()
  const path = topic.path.toLowerCase()

  if (name === query) return 0
  if (name.startsWith(query)) return 1
  if (name.includes(query)) return 2
  if (path.includes(query)) return 3
  return Number.POSITIVE_INFINITY
}

export default function TopicPicker({ topics, value, onChange, disabled }: Props) {
  const inputId = useId()
  const listId = useId()

  const selected = useMemo(
    () => topics.find((topic) => topic.id === value) ?? null,
    [topics, value],
  )

  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const results = useMemo(() => {
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) return topics.slice(0, MAX_RESULTS)

    return topics
      .map((topic) => ({ topic, rank: score(topic, trimmed) }))
      .filter((entry) => Number.isFinite(entry.rank))
      .sort((a, b) => a.rank - b.rank || a.topic.path.localeCompare(b.topic.path))
      .slice(0, MAX_RESULTS)
      .map((entry) => entry.topic)
  }, [topics, query])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  function updateQuery(next: string) {
    setQuery(next)
    setActive(0)
  }

  function commit(topic: TopicChoice | null) {
    onChange(topic?.id ?? null)
    updateQuery('')
    setOpen(false)
  }

  return (
    <div ref={containerRef} className="relative">
      <span className="label" id={`${inputId}-label`}>
        Topic
      </span>

      {selected && !open ? (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate rounded-xl bg-surface px-3 py-2 text-sm">
            {selected.path}
          </span>
          <button
            type="button"
            className="btn-compact shrink-0 rounded px-2 text-sm text-muted underline underline-offset-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            disabled={disabled}
            onClick={() => {
              setOpen(true)
              requestAnimationFrame(() => document.getElementById(inputId)?.focus())
            }}
          >
            Change
          </button>
        </div>
      ) : (
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-labelledby={`${inputId}-label`}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && results[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          placeholder="Search topics, e.g. triangles…"
          className="field"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            updateQuery(event.target.value)
            setOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setOpen(true)
              setActive((index) => Math.min(index + 1, results.length - 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActive((index) => Math.max(index - 1, 0))
            } else if (event.key === 'Enter') {
              if (open && results[active]) {
                event.preventDefault()
                commit(results[active])
              }
            } else if (event.key === 'Escape') {
              setOpen(false)
            }
          }}
        />
      )}

      {open && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl bg-surface shadow-lg">
          {results.length === 0 && (
            <p className="px-3 py-2 text-sm text-muted">
              No topic matches that. Try a broader word, or leave it unset.
            </p>
          )}

          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Topics"
            className="max-h-64 overflow-y-auto overscroll-contain"
          >
            {results.map((topic, index) => (
              <div
                key={topic.id}
                id={`${listId}-${index}`}
                data-index={index}
                role="option"
                aria-selected={index === active}
                className={`cursor-pointer px-3 py-2 text-left text-sm ${
                  index === active ? 'bg-accent/10' : ''
                }`}
                onPointerEnter={() => setActive(index)}
                onClick={() => commit(topic)}
              >
                <span className="block truncate font-medium">{topic.name}</span>
                <span className="block truncate text-xs text-muted">{topic.path}</span>
              </div>
            ))}
          </div>

          {selected && (
            <div className="">
              <button
                type="button"
                className="block w-full px-3 py-2 text-left text-sm text-muted hover:text-danger"
                onClick={() => commit(null)}
              >
                Clear topic
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
