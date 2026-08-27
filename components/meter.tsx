import {MIN_ATTEMPTS} from '@/lib/upload'

const PERCENT = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 0,
})

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
      className={`w-full bg-wash ${thick ? 'h-3' : 'h-2'}`}
    >
      <div
        className={`h-full ${ranked ? 'bg-fg' : 'bg-muted'}`}
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
