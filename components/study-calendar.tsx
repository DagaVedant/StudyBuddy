import {type StudyDay} from '@/lib/dashboard'

const DAY_MS = 86_400_000

function bestRun(days: StudyDay[]): number {
  let best = 0
  let run = 0
  let previous: number | null = null

  for (const day of days) {
    const at = Date.parse(`${day.day}T00:00:00Z`)
    run = previous !== null && at - previous === DAY_MS ? run + 1 : 1
    if (run > best) best = run
    previous = at
  }

  return best
}

export function StudyCalendar({
  days,
  streak,
  weeks,
}: {
  days: StudyDay[]
  streak: number
  weeks: number
}) {
  const studied = days.filter((day) => day.total > 0).length
  const answered = days.reduce((sum, day) => sum + day.total, 0)
  const span = weeks * 7

  return (
    <dl className="text-sm">
      <div>
        <dt className="inline text-muted">Days studied: </dt>
        <dd className="inline tabular-nums">
          {studied} of the last {span}
        </dd>
      </div>
      <div>
        <dt className="inline text-muted">Questions answered: </dt>
        <dd className="inline tabular-nums">{answered}</dd>
      </div>
      <div>
        <dt className="inline text-muted">Current streak: </dt>
        <dd className="inline tabular-nums">
          {streak} {streak === 1 ? 'day' : 'days'}
        </dd>
      </div>
      <div>
        <dt className="inline text-muted">Longest streak: </dt>
        <dd className="inline tabular-nums">
          {bestRun(days)} {bestRun(days) === 1 ? 'day' : 'days'}
        </dd>
      </div>
    </dl>
  )
}
