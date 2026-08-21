import { MIN_ATTEMPTS } from '@/lib/dashboard'

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
  thick = false,
}: {
  accuracy: number
  ranked?: boolean
  label: string
  thick?: boolean
}) {
  const pct = Math.round(accuracy * 100)

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
      className={`w-full overflow-hidden bg-fg/15 ${thick ? 'h-3' : 'h-1.5'}`}
    >
      <div
        className={`h-full ${FILL[band(accuracy, ranked)]}`}
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
