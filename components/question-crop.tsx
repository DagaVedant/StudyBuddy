import type { QuestionEvidence } from '@/lib/questions/evidence'

/**
 * Kept around the box, as a fraction of it.
 *
 * The boxes the reader reports are loose: page-canvas.tsx records that they
 * framed the wrong lines about as often as the right ones. A crop cut exactly
 * to one clips the first line of the question it is meant to show, so a little
 * of the page either side comes along.
 */
const CROP_MARGIN = 0.04

/**
 * The page image, cropped to one question.
 *
 * Shared by the verify screen, which shows it beside what we read off the
 * page, and the review screen, which shows it because a question about a
 * diagram cannot be answered without one. Nothing in the pipeline ever crops a
 * figure to its own file; this is a crop window over the page image, so it
 * costs no storage and no pass, and works for every question that recorded a
 * box.
 */
export default function QuestionCrop({
  image,
  alt,
}: {
  image: QuestionEvidence
  alt: string
}) {
  const [x0, y0, x1, y1] = image.bbox

  const padX = (x1 - x0) * CROP_MARGIN
  const padY = (y1 - y0) * CROP_MARGIN
  const left = Math.max(0, x0 - padX)
  const top = Math.max(0, y0 - padY)
  const cropWidth = Math.min(image.width, x1 + padX) - left
  const cropHeight = Math.min(image.height, y1 + padY) - top

  return (
    // The border lives on the outer box, not on the one carrying the aspect
    // ratio. Tailwind's preflight sets border-box sizing, so `aspect-ratio`
    // sizes the border box while a percentage `top` on the image resolves
    // against the padding box: with a 1px border those differ, and the crop
    // drifted upward the further down the page the question sat. A question
    // near the bottom of a 1650px scan showed the line above the one it meant.
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="relative" style={{ aspectRatio: `${cropWidth} / ${cropHeight}` }}>
        {/* Authenticated dynamic route; next/image can't forward the session.
            The image is laid out in page pixels scaled to the box: its width is
            the whole page measured in crop widths, then shifted so the crop's
            top left lands on the box's. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={image.src}
          alt={alt}
          width={image.width}
          height={image.height}
          className="absolute max-w-none"
          style={{
            left: `${(-left / cropWidth) * 100}%`,
            top: `${(-top / cropHeight) * 100}%`,
            width: `${(image.width / cropWidth) * 100}%`,
            height: 'auto',
          }}
        />
      </div>
    </div>
  )
}
