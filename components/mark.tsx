/*
 * The mark: a tick.
 *
 * It was four rounded squares, two of them dimmed, which is close to the
 * platonic generated-startup logo and said nothing about what this app is.
 * A tick is the mark a teacher puts on a worksheet, which is the one gesture
 * the whole product is built around, and it is legible at 16px, which most
 * literal marks are not.
 *
 * Stroked rather than a filled tapered shape on purpose. A pen taper is
 * sub-pixel at the sizes this actually renders (18px in the masthead), so it
 * would be effort spent on something nobody can see; the hand-drawn character
 * lives in `components/hand.tsx`, at sizes where it reads. What this does
 * borrow is the curve: both strokes bow slightly, because a tick drawn from
 * two straight segments is the one thing that looks machine-made.
 *
 * `app/opengraph-image.tsx` draws this again as an inline SVG data URI, since
 * Satori cannot render the component, so the two have to change together.
 */
export default function Mark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="3.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Centred by rasterising it and measuring, not by eye: the ink sits
          2px in from each side and 5px from top and bottom of a 48px raster. */}
      <path d="M2.6 13.9C4.3 15.4 5.9 17.4 7.5 19.7 11.7 13.7 16.3 8.3 21.4 4.4" />
    </svg>
  )
}
