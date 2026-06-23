import { MIN_ATTEMPTS } from '@/lib/dashboard/ranking'

const PERCENT = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 0,
})

/**
 * A single ratio against a limit is a **meter**, not a donut — a two-slice pie
 * is the wrong form for one percentage, and a meter stays readable at the sizes
 * a topic list actually uses.
 *
 * Colour here is *status*, not identity: how bad the accuracy is. Status is
 * never carried by colour alone — the percentage is always printed beside it.
 */

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

  return (
    <div
      role="meter"
      aria-valuenow={ranked ? pct : undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={
        ranked ? `${label}: ${PERCENT.format(accuracy)} correct` : `${label}: not enough data`
      }
      className="h-1.5 w-full overflow-hidden rounded-full bg-border"
    >
      <div
        className={`h-full rounded-full ${FILL[band(accuracy, ranked)]}`}
        style={{ width: `${ranked ? Math.max(pct, 2) : 100}%` }}
      />
    </div>
  )
}

/** The accuracy number itself, or an explicit low-evidence state. */
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
