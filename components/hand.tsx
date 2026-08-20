/*
 * The two marks that are drawn rather than laid out.
 *
 * Every other shape in this interface is something a stylesheet can describe
 * exactly: a rectangle, a circle, a line at a right angle. That exactness is
 * most of what makes an interface read as generated, and no amount of good
 * spacing fixes it, because the eye is reacting to the absence of a hand
 * rather than to the arrangement.
 *
 * So these two are wobbly on purpose. The underline does not sit level, the
 * tick does not have equal arms, and neither is symmetrical. They are used
 * sparingly, twice in the whole app, because the effect depends entirely on
 * being rare: a hand-drawn flourish on every heading is just another system.
 */

/*
 * A pen underline, for the one phrase on a page that carries the answer.
 *
 * `preserveAspectRatio="none"` lets it stretch to whatever it is underlining,
 * which does flatten the wobble on a long phrase, so the path is drawn with
 * more vertical travel than looks right at authoring size to survive it. It
 * is absolutely positioned and `aria-hidden`, so it never affects layout or
 * the reading order.
 */
export function Underline({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 300 14"
      preserveAspectRatio="none"
      fill="none"
      className={`pointer-events-none absolute left-0 top-[92%] h-[0.26em] w-full ${className}`}
    >
      <path
        d="M3 8.5C52 4.2 104 10.4 152 6.1 200 1.8 249 9.7 297 5"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  )
}

/*
 * A marking tick, for a correct answer.
 *
 * Rougher and less even than the wordmark in `mark.tsx`: the down-stroke is
 * short and steep, the up-stroke overshoots, and the whole thing leans. That
 * is the difference between a logo, which has to survive being shrunk to a
 * favicon, and a mark somebody made in a hurry with a red pen.
 */
export function Tick({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M3.4 12.8C5.1 14.1 6.6 16 8.1 18.6 11.6 12.1 15.9 6.6 21 2.6" />
    </svg>
  )
}
