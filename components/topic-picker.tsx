'use client'

import {useEffect, useId, useRef, useState} from 'react'

export type TopicChoice = {
  id: string
  slug: string
  name: string
  path: string
}

function score(topic: TopicChoice, query: string) {
  let name = topic.name.toLowerCase()
  let path = topic.path.toLowerCase()

  if (name === query) return 0
  if (name.startsWith(query)) return 1
  if (name.includes(query)) return 2
  if (path.includes(query)) return 3
  return -1
}

function search(topics: TopicChoice[], query: string) {
  let trimmed = query.trim().toLowerCase()
  if (!trimmed) return topics.slice(0, 40)

  let matches = []

  for (let topic of topics) {
    let rank = score(topic, trimmed)
    if (rank >= 0) matches.push({topic: topic, rank: rank})
  }

  matches.sort(function (a, b) {
    if (a.rank !== b.rank) return a.rank - b.rank
    if (a.topic.path < b.topic.path) return -1
    if (a.topic.path > b.topic.path) return 1
    return 0
  })

  let out = []
  for (let i = 0; i < matches.length && i < 40; i++) {
    out.push(matches[i].topic)
  }

  return out
}

export function TopicPicker({
  topics,
  value,
  onChange,
}: {
  topics: TopicChoice[]
  value: string | null
  onChange: (topicId: string | null) => void
}) {
  const inputId = useId()
  const listId = useId()

  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  let selected: TopicChoice | null = null
  for (let topic of topics) {
    if (topic.id === value) selected = topic
  }

  let results = search(topics, query)

  useEffect(() => {
    if (!open) return

    function onPointerDown(event: PointerEvent) {
      let container = containerRef.current
      if (container && container.contains(event.target as Node)) return

      setQuery('')
      setActive(0)
      setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  useEffect(() => {
    if (!open) return

    let list = listRef.current
    if (!list) return

    let option = list.querySelector('[data-index="' + active + '"]')
    if (option) option.scrollIntoView({block: 'nearest'})
  }, [active, open])

  function commit(topic: TopicChoice | null) {
    if (topic) {
      onChange(topic.id)
    } else {
      onChange(null)
    }

    setQuery('')
    setActive(0)
    setOpen(false)
  }

  let options = []
  for (let index = 0; index < results.length; index++) {
    let topic = results[index]

    let optionClass = 'cursor-pointer px-3 py-2 text-left text-sm'
    if (index === active) optionClass = optionClass + ' bg-accent/10'

    options.push(
      <div
        key={topic.id}
        id={listId + '-' + index}
        data-index={index}
        role="option"
        aria-selected={index === active}
        className={optionClass}
        onPointerEnter={() => setActive(index)}
        onClick={() => commit(topic)}
      >
        <span className="block truncate font-medium">{topic.name}</span>
        <span className="block truncate text-xs text-muted">{topic.path}</span>
      </div>,
    )
  }

  let activeId = undefined
  if (open && results[active]) activeId = listId + '-' + active

  return (
    <div ref={containerRef} className="relative">
      <span className="label" id={inputId + '-label'}>
        Topic
      </span>

      {selected && !open ? (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate rounded-xl bg-surface px-3 py-2 text-sm">
            {selected.path}
          </span>
          <button
            type="button"
            className="btn-compact shrink-0 rounded px-2 text-sm text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onClick={() => {
              setOpen(true)
              requestAnimationFrame(() => {
                const field = document.getElementById(inputId)
                if (field) field.focus()
              })
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
          aria-labelledby={inputId + '-label'}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          autoComplete="off"
          spellCheck={false}
          placeholder="Search topics, e.g. triangles…"
          className="field"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
            setOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setOpen(true)

              let next = active + 1
              if (next > results.length - 1) next = results.length - 1
              setActive(next)
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()

              let next = active - 1
              if (next < 0) next = 0
              setActive(next)
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
        <div className="absolute z-20 mt-1 w-full border border-rule-heavy bg-surface">
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
            className="max-h-64 overflow-y-auto"
          >
            {options}
          </div>

          {selected && (
            <button
              type="button"
              className="block w-full px-3 py-2 text-left text-sm text-muted hover:text-danger"
              onClick={() => commit(null)}
            >
              Clear topic
            </button>
          )}
        </div>
      )}
    </div>
  )
}
