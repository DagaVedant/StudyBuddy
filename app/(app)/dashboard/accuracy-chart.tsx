'use client'

import { useId, useState } from 'react'

import type { SubjectTrend, TrendPoint } from '@/lib/dashboard/queries'

/**
 * A week-start as a short date.
 *
 * Formatted in UTC, not just parsed in it. `weekStart` is a bare `YYYY-MM-DD`
 * off `to_char(date_trunc('week', ...))`, and a bare date string is parsed as
 * midnight UTC; formatting it in a timezone behind UTC hands back the previous
 * day, so every label was off by one west of Greenwich.
 */
const WEEK_OF = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})

const WEEK_LABEL = (weekStart: string) => WEEK_OF.format(new Date(weekStart))

/** Turns `high-school-math` into `High school math`. */
function subjectLabel(root: string): string {
  const words = root.replace(/-/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * spec.md:406: "Weekly line chart, toggleable overall vs. per-subject."
 *
 * Only the overall half was built, which answers "is any of this working" and
 * cannot answer "is it working at the thing I have been grinding". A student who
 * spent a month on geometry while coasting through algebra reads the same flat
 * line either way.
 *
 * A client component only because of the toggle. Everything it draws is
 * computed on the server and handed over whole, so switching series is a state
 * change and not a fetch: the two datasets together are a few hundred integers,
 * and asking the server on every toggle would be slower and would put a
 * loading state in the middle of a comparison.
 */
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
  // At least 1, so a series of empty weeks divides by something.
  const maxWeek = Math.max(1, ...totals)

  return (
    <>
      {/*
        Only offered when there is more than one subject to compare. With a
        single subject the toggle's two positions draw the identical chart,
        which teaches a student that the control does nothing.
      */}
      {bySubject.length > 1 && (
        <div className="mb-3 flex items-center gap-2">
          <label className="text-sm text-muted" htmlFor={selectId}>
            Show
          </label>
          <select
            id={selectId}
            className="field sm:max-w-xs"
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

      {/*
        `items-stretch`, not `items-end`. Each column is a flex child whose own
        children are sized in percentages, and a percentage height resolves
        against the parent's height: with `items-end` the column was sized by
        its content, its content was three divs asking for a percentage of it,
        and the whole thing collapsed to nothing. `justify-end` on the column is
        what stacks them from the bottom, which is the part `items-end` looked
        like it was doing.

        A `title` attribute is a mouse-only affordance: nothing else can trigger
        it, so a sighted keyboard user, or anyone on a touchscreen, had no way to
        read what one bar stood for. Each column is focusable, and the text the
        title used to hold shows on focus or hover. Still `aria-hidden`, and
        still deliberately so: the table below is the one channel screen readers
        read this chart through, so this stays visual-only rather than
        announcing a redundant second copy of the same numbers.
      */}
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

      {/*
        Which weeks these bars are. Every week in the range is a bar, including
        the ones with nothing in them, so the axis is a plain span from the
        first to the last and does not need a tick per bar to be read honestly.
      */}
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
          <span className="size-2 rounded-full bg-accent" aria-hidden="true" />
          Correct
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-muted/50" aria-hidden="true" />
          Unsure
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-danger/70" aria-hidden="true" />
          Missed
        </span>
      </p>
    </>
  )
}
