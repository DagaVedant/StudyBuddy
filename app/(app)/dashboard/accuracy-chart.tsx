'use client'

import { useId, useState } from 'react'

import type { SubjectTrend, TrendPoint } from '@/lib/dashboard'

const WEEK_OF = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})

const WEEK_LABEL = (weekStart: string) => WEEK_OF.format(new Date(weekStart))

function subjectLabel(root: string): string {
  const words = root.replace(/-/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export default function AccuracyChart({
  overall,
  bySubject,
}: {
  overall: TrendPoint[]
  bySubject: SubjectTrend[]
}) {
  const [subject, setSubject] = useState<string>('')
  const selectId = useId()

  const series = subject
    ? (bySubject.find((row) => row.subjectRoot === subject)?.points ?? overall)
    : overall

  const totals = series.map((point) => point.correct + point.unsure + point.wrong)
  const maxWeek = Math.max(1, ...totals)

  return (
    <>
      {bySubject.length > 1 && (
        <div className="mb-3 flex items-center gap-2">
          <label className="text-sm text-muted" htmlFor={selectId}>
            Show
          </label>
          <select
            id={selectId}
            className="field bg-surface sm:max-w-xs"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          >
            <option value="">Everything</option>
            {bySubject.map((row) => (
              <option key={row.subjectRoot} value={row.subjectRoot}>
                {subjectLabel(row.subjectRoot)}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex h-28 items-stretch gap-1" aria-hidden="true">
        {series.map((point) => {
          const total = point.correct + point.unsure + point.wrong
          const scale = (value: number) => (value / maxWeek) * 100

          return (
            <div
              key={point.weekStart}
              tabIndex={0}
              className="group relative flex min-w-0 flex-1 flex-col justify-end rounded-t-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-lg bg-fg px-2 py-1 text-xs text-bg group-hover:block group-focus-visible:block">
                {point.correct} correct, {point.unsure} unsure, {point.wrong} missed
              </span>
              <div
                className="w-full rounded-t-sm bg-danger/70"
                style={{ height: `${scale(point.wrong)}%` }}
              />
              <div
                className="w-full bg-muted/50"
                style={{ height: `${scale(point.unsure)}%` }}
              />
              <div
                className="w-full bg-accent"
                style={{ height: `${scale(point.correct)}%` }}
              />
              <span className="sr-only">{total}</span>
            </div>
          )
        })}
      </div>

      <p
        aria-hidden="true"
        className="mt-1.5 flex justify-between text-xs tabular-nums text-muted"
      >
        <span>{WEEK_LABEL(series[0].weekStart)}</span>
        <span>{WEEK_LABEL(series.at(-1)!.weekStart)}</span>
      </p>

      <table className="sr-only">
        <caption>
          Attempts by week{subject ? `, ${subjectLabel(subject)} only` : ''}
        </caption>
        <thead>
          <tr>
            <th scope="col">Week</th>
            <th scope="col">Correct</th>
            <th scope="col">Unsure</th>
            <th scope="col">Missed</th>
          </tr>
        </thead>
        <tbody>
          {series.map((point) => (
            <tr key={point.weekStart}>
              <th scope="row">{point.weekStart}</th>
              <td>{point.correct}</td>
              <td>{point.unsure}</td>
              <td>{point.wrong}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="hint flex flex-wrap gap-x-4">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 bg-accent" aria-hidden="true" />
          Correct
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 bg-muted/50" aria-hidden="true" />
          Unsure
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 bg-danger/70" aria-hidden="true" />
          Missed
        </span>
      </p>
    </>
  )
}
