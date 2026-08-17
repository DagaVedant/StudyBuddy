export interface PageImage {
  image: Uint8Array
  mediaType: string
}

export async function toPngBytes(blob: Blob): Promise<PageImage> {
  if (blob.type === 'image/png' || blob.type === 'image/jpeg') {
    return { image: new Uint8Array(await blob.arrayBuffer()), mediaType: blob.type }
  }

  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height

    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('This browser would not give us a canvas to convert the page on.')
    }
    context.drawImage(bitmap, 0, 0)

    const png = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    )
    if (!png) throw new Error('The page image could not be converted to PNG.')

    return { image: new Uint8Array(await png.arrayBuffer()), mediaType: 'image/png' }
  } finally {
    bitmap.close()
  }
}

export async function fetchPageImage(imageKey: string): Promise<PageImage> {
  const response = await fetch(`/api/files/${imageKey}`)
  if (!response.ok) throw new Error('Could not load the page image.')

  return toPngBytes(await response.blob())
}
