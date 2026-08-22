import {MIN_ATTEMPTS} from '@/lib/upload'

const PERCENT = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 0,
})

function fill(accuracy: number, ranked: boolean) {
  if (!ranked) return 'bg-muted/40'
  if (accuracy < 0.5) return 'bg-danger'
  if (accuracy < 0.7) return 'bg-warning'
  if (accuracy < 0.85) return 'bg-caution'
  return 'bg-success'
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
        role: 'meter',
        'aria-valuenow': pct,
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-label': `${label}: ${PERCENT.format(accuracy)} correct`,
      }
    : {'aria-hidden': true}

  return (
    <div
      {...measured}
      className={`w-full overflow-hidden bg-fg/15 ${thick ? 'h-3' : 'h-1.5'}`}
    >
      <div
        className={`h-full ${fill(accuracy, ranked)}`}
        style={{width: `${ranked ? Math.max(pct, 2) : 100}%`}}
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
