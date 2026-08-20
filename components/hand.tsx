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

/*
 * A pencil box, ruled round a section the way you would box something in a
 * textbook you were working through.
 *
 * Stretched to the element with `preserveAspectRatio="none"`, which sounds
 * wrong for a hand-drawn line and is not: the wobble on the top and bottom
 * edges lives in Y and stretching in X leaves it untouched, and the same
 * holds for the side edges in reverse. Only the frequency changes, not the
 * amplitude, so a wide box gets long lazy waves and a narrow one gets tighter
 * ones. That is what a drawn line actually does.
 *
 * `vector-effect="non-scaling-stroke"` is the part that makes it work. Without
 * it the uneven scale would make the horizontal strokes a different weight
 * from the vertical ones, which reads instantly as a bug rather than as a
 * hand.
 *
 * The four edges are separate paths that overshoot their corners slightly,
 * because a pencil ruled into a corner overshoots and a perfectly closed
 * rectangle is the one thing that would give it away as generated.
 */
export function PencilFrame({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 200 100"
      preserveAspectRatio="none"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      vectorEffect="non-scaling-stroke"
      className={`pointer-events-none absolute inset-0 h-full w-full text-pencil ${className}`}
    >
      <path vectorEffect="non-scaling-stroke" d="M1.4 3.1C46 1.4 118 4.2 199 2.1" />
      <path vectorEffect="non-scaling-stroke" d="M198.4 1.2C199.6 28 197.4 68 198.6 98.6" />
      <path vectorEffect="non-scaling-stroke" d="M199.2 97.6C132 99.4 58 96.9 0.9 98.7" />
      <path vectorEffect="non-scaling-stroke" d="M1.8 99.1C0.6 71 2.7 31 1.5 1.1" />
    </svg>
  )
}

/*
 * A pencil rule under a heading. Shorter and steadier than `Underline`, which
 * is a flourish; this one is doing the job a ruler does.
 */
export function PencilRule({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 120 4"
      preserveAspectRatio="none"
      fill="none"
      className={`h-[3px] w-full text-pencil ${className}`}
    >
      <path
        vectorEffect="non-scaling-stroke"
        d="M1 2.4C24 1.2 52 3 76 1.7 94 0.8 108 2.6 119 1.9"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  )
}
