'use client'

import {useId, useState} from 'react'

import type {SubjectTrend, TrendPoint} from '@/lib/dashboard'

const WEEK_OF = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})

function weekLabel(weekStart: string): string {
  return WEEK_OF.format(new Date(weekStart))
}

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
  const [subject, setSubject] = useState('')
  const selectId = useId()

  let series = overall
  if (subject) {
    const match = bySubject.find((row) => row.subjectRoot === subject)
    if (match) series = match.points
  }

  return (
    <>
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

      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          Attempts by week{subject ? `, ${subjectLabel(subject)} only` : ''}
        </caption>
        <thead>
          <tr>
            <th scope="col" className="border border-rule px-2 py-1 text-left">
              Week
            </th>
            <th scope="col" className="border border-rule px-2 py-1 text-right">
              Correct
            </th>
            <th scope="col" className="border border-rule px-2 py-1 text-right">
              Unsure
            </th>
            <th scope="col" className="border border-rule px-2 py-1 text-right">
              Missed
            </th>
          </tr>
        </thead>
        <tbody>
          {series.map((point) => (
            <tr key={point.weekStart}>
              <th scope="row" className="border border-rule px-2 py-1 text-left font-normal">
                {weekLabel(point.weekStart)}
              </th>
              <td className="border border-rule px-2 py-1 text-right tabular-nums">
                {point.correct}
              </td>
              <td className="border border-rule px-2 py-1 text-right tabular-nums">
                {point.unsure}
              </td>
              <td className="border border-rule px-2 py-1 text-right tabular-nums">
                {point.wrong}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
