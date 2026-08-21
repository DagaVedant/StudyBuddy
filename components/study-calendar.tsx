import type { StudyDay } from '@/lib/dashboard'


const DAY_MS = 86_400_000

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

function key(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function level(total: number): 0 | 1 | 2 | 3 | 4 {
  if (total === 0) return 0
  if (total < 5) return 1
  if (total < 15) return 2
  if (total < 30) return 3
  return 4
}

const FILL: Record<number, string> = {
  0: 'bg-fg/10',
  1: 'bg-marker/30',
  2: 'bg-marker/55',
  3: 'bg-marker/80',
  4: 'bg-marker',
}

export default function StudyCalendar({
  days,
  streak,
  weeks = 26,
}: {
  days: StudyDay[]
  streak: number
  weeks?: number
}) {
  const WEEKS = weeks
  const byDay = new Map(days.map((day) => [day.day, day]))

  const today = new Date()
  const end = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  )
  const start = new Date(end.getTime() - (WEEKS * 7 - 1) * DAY_MS)
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7))

  const columns: { date: Date; day: StudyDay | undefined }[][] = []
  for (
    let cursor = new Date(start);
    cursor <= end;
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    const weekday = (cursor.getUTCDay() + 6) % 7
    if (weekday === 0) columns.push([])
    const date = new Date(cursor)
    columns[columns.length - 1]?.push({ date, day: byDay.get(key(date)) })
  }

  let lastLabelAt = -99

  const studied = days.length
  const total = days.reduce((sum, day) => sum + day.total, 0)
  const best = bestRun(days)

  return (
    <div>
      <dl className="mb-3 flex flex-wrap gap-x-6 gap-y-1">
        <Figure label="Current run" value={streak} unit="days" />
        <Figure label="Best run" value={best} unit="days" />
        <Figure label="Days studied" value={studied} unit={`of ${WEEKS * 7}`} />
      </dl>

      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <div className="flex min-w-max gap-1.5">
          <div
            aria-hidden="true"
            className="grid shrink-0 grid-rows-7 gap-[3px] pt-[15px] text-right"
          >
            {WEEKDAYS.map((name, row) => (
              <span
                key={name}
                className="font-mono text-[9px] leading-[12px] text-muted"
              >
                {row % 2 === 1 ? name : ''}
              </span>
            ))}
          </div>

          <div>
            <div className="flex gap-[3px]">
              {columns.map((week, index) => {
                const first = week[0]?.date
                const previous = columns[index - 1]?.[0]?.date
                const isNewMonth =
                  first &&
                  (!previous || previous.getUTCMonth() !== first.getUTCMonth())
                const roomSinceLast = index - lastLabelAt >= 3
                const showLabel = isNewMonth && roomSinceLast
                if (showLabel) lastLabelAt = index

                return (
                  <span
                    key={first ? key(first) : index}
                    aria-hidden="true"
                    className="w-[12px] font-mono text-[9px] leading-[12px] text-muted"
                  >
                    {showLabel ? MONTHS[first.getUTCMonth()] : ''}
                  </span>
                )
              })}
            </div>

            <div className="mt-[3px] flex gap-[3px]">
              {columns.map((week, index) => (
                <div key={index} className="grid grid-rows-7 gap-[3px]">
                  {week.map(({ date, day }) => (
                    <span
                      key={key(date)}
                      title={describe(date, day)}
                      className={`size-[12px] ${
                        FILL[level(day?.total ?? 0)]
                      }`}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <p className="sr-only">
        You have studied on {studied} of the last {WEEKS * 7} days, {total}{' '}
        questions in total. Your current run is {streak}{' '}
        {streak === 1 ? 'day' : 'days'} and your best run in this period is{' '}
        {best} {best === 1 ? 'day' : 'days'}.
      </p>

      <div
        aria-hidden="true"
        className="mt-2 flex items-center justify-end gap-1.5"
      >
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted">
          Lighter
        </span>
        {[0, 1, 2, 3, 4].map((step) => (
          <span
            key={step}
            className={`size-[10px] ${FILL[step]}`}
          />
        ))}
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted">
          Heavier
        </span>
      </div>
    </div>
  )
}

function Figure({
  label,
  value,
  unit,
}: {
  label: string
  value: number
  unit: string
}) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="font-display text-xl font-semibold tabular-nums">
        {value}{' '}
        <span className="font-sans text-xs font-normal text-muted">{unit}</span>
      </dd>
    </div>
  )
}

function describe(date: Date, day: StudyDay | undefined): string {
  const when = date.toISOString().slice(0, 10)
  if (!day) return `${when}: nothing`
  return `${when}: ${day.total} answered, ${day.correct} right, ${day.wrong} missed`
}

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
