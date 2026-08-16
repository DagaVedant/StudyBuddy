import type { TopicTrend } from '@/lib/dashboard/ranking'

/**
 * spec.md:398's trend arrow, whose example row is `38% (8/21) ↓`.
 *
 * The arrow is what says whether the percentage beside it is the story so far
 * or the story now, which is the difference between a topic worth an evening
 * and one already on its way up.
 *
 * A glyph rather than an icon font or an emoji, for the same reason the delete
 * dialog draws its own bin: an emoji arrow is painted by the platform, ignores
 * the theme, and is a different drawing on each of them. `aria-hidden` with a
 * real sentence beside it, because "↑" read aloud is "up arrow" and that is not
 * what it means here.
 */
export default function TrendArrow({ trend }: { trend: TopicTrend }) {
  // Null means there is not enough history to say, which is different from
  // 'flat'. Drawing nothing is the honest rendering of that; a dash would read
  // as a measured result.
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
