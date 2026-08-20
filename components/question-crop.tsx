import type { QuestionEvidence } from '@/lib/questions/text'

const CROP_MARGIN = 0.04

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
    <div className="my-0.5 overflow-hidden rounded-lg [rotate:0.35deg]">
      <div className="relative" style={{ aspectRatio: `${cropWidth} / ${cropHeight}` }}>
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
