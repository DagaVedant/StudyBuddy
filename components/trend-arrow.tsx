import type { TopicTrend } from '@/lib/dashboard/ranking'

export default function TrendArrow({ trend }: { trend: TopicTrend }) {
  if (trend === null) return null

  const face = {
    up: { glyph: '↑', className: 'text-success', label: 'Improving' },
    down: { glyph: '↓', className: 'text-danger', label: 'Getting worse' },
    flat: { glyph: '→', className: 'text-muted', label: 'Holding steady' },
  }[trend]

  return (
    <>
      <span aria-hidden="true" className={`text-sm ${face.className}`}>
        {face.glyph}
      </span>
      <span className="sr-only">{face.label} since you started this topic.</span>
    </>
  )
}
