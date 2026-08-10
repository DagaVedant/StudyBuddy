import { MIN_ATTEMPTS } from '@/lib/dashboard/ranking'

const PERCENT = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 0,
})

type Band = 'critical' | 'serious' | 'warning' | 'good' | 'unknown'

function band(accuracy: number, ranked: boolean): Band {
  if (!ranked) return 'unknown'
  if (accuracy < 0.5) return 'critical'
  if (accuracy < 0.7) return 'serious'
  if (accuracy < 0.85) return 'warning'
  return 'good'
}

const FILL: Record<Band, string> = {
  critical: 'bg-danger',
  serious: 'bg-warning',
  warning: 'bg-caution',
  good: 'bg-success',
  unknown: 'bg-muted/40',
}

export function Meter({
  accuracy,
  ranked = true,
  label,
}: {
  accuracy: number
  ranked?: boolean
  label: string
}) {
  const pct = Math.round(accuracy * 100)

  /*
   * No `role="meter"` when there is nothing to measure.
   *
   * `aria-valuenow` is required on a meter, and it was being left off in the
   * unranked branch because there is genuinely no reading to give: the topic
   * has not been answered enough times to say anything about it. A meter
   * without a value is invalid ARIA, and a screen reader announcing "meter" and
   * then no percentage is worse than not announcing a meter at all. The bar
   * still draws, greyed and full width, as the placeholder it always was; the
   * label beside it is what carries "3/5 answered".
   */
  const measured = ranked
    ? {
        role: 'meter' as const,
        'aria-valuenow': pct,
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-label': `${label}: ${PERCENT.format(accuracy)} correct`,
      }
    : { 'aria-hidden': true as const }

  return (
    <div
      {...measured}
      className="h-1.5 w-full overflow-hidden rounded-full bg-border"
    >
      <div
        className={`h-full rounded-full ${FILL[band(accuracy, ranked)]}`}
        style={{ width: `${ranked ? Math.max(pct, 2) : 100}%` }}
      />
    </div>
  )
}

export function AccuracyLabel({
  accuracy,
  ranked,
  attempts,
}: {
  accuracy: number
  ranked: boolean
  attempts: number
}) {
  if (!ranked) {
    return (
      <span className="text-sm text-muted">
        {attempts}/{MIN_ATTEMPTS} answered
      </span>
    )
  }

  return <span className="text-sm font-medium tabular-nums">{PERCENT.format(accuracy)}</span>
}
