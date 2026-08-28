import {MIN_ATTEMPTS} from '@/lib/upload'

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
  let pct = Math.round(accuracy * 100)

  let height = 'h-2'
  if (thick) height = 'h-3'

  if (!ranked) {
    return (
      <div aria-hidden={true} className={'w-full bg-wash ' + height}>
        <div className="h-full bg-muted" style={{width: '100%'}} />
      </div>
    )
  }

  let width = pct
  if (width < 2) width = 2

  return (
    <div
      role="meter"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label + ': ' + pct + '% correct'}
      className={'w-full bg-wash ' + height}
    >
      <div className="h-full bg-fg" style={{width: width + '%'}} />
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

  return <span className="text-sm font-medium tabular-nums">{Math.round(accuracy * 100)}%</span>
}
