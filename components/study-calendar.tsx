import {type StudyDay} from '@/lib/dashboard'

function bestRun(days: StudyDay[]) {
  let best = 0
  let run = 0
  let previous: number | null = null

  for (let day of days) {
    let at = Date.parse(day.day + 'T00:00:00Z')

    if (previous !== null && at - previous === 86400000) {
      run = run + 1
    } else {
      run = 1
    }

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
  let studied = 0
  let answered = 0

  for (let day of days) {
    if (day.total > 0) studied = studied + 1
    answered = answered + day.total
  }

  let span = weeks * 7
  let longest = bestRun(days)

  let streakWord = 'days'
  if (streak === 1) streakWord = 'day'

  let longestWord = 'days'
  if (longest === 1) longestWord = 'day'

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
          {streak} {streakWord}
        </dd>
      </div>
      <div>
        <dt className="inline text-muted">Longest streak: </dt>
        <dd className="inline tabular-nums">
          {longest} {longestWord}
        </dd>
      </div>
    </dl>
  )
}
