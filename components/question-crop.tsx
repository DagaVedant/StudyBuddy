import {type QuestionEvidence} from '@/lib/questions/shape'

export function QuestionCrop({
  image,
  alt,
}: {
  image: QuestionEvidence
  alt: string
}) {
  let x0 = image.bbox[0]
  let y0 = image.bbox[1]
  let x1 = image.bbox[2]
  let y1 = image.bbox[3]

  let padX = (x1 - x0) * 0.04
  let padY = (y1 - y0) * 0.04

  let left = x0 - padX
  if (left < 0) left = 0

  let top = y0 - padY
  if (top < 0) top = 0

  let right = x1 + padX
  if (right > image.width) right = image.width

  let bottom = y1 + padY
  if (bottom > image.height) bottom = image.height

  let cropWidth = right - left
  let cropHeight = bottom - top

  return (
    <div className="my-0.5 overflow-hidden rounded-lg [rotate:0.35deg]">
      <div className="relative" style={{aspectRatio: cropWidth + ' / ' + cropHeight}}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={image.src}
          alt={alt}
          width={image.width}
          height={image.height}
          className="absolute max-w-none"
          style={{
            left: (-left / cropWidth) * 100 + '%',
            top: (-top / cropHeight) * 100 + '%',
            width: (image.width / cropWidth) * 100 + '%',
            height: 'auto',
          }}
        />
      </div>
    </div>
  )
}
