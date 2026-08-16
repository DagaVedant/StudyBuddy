export const MAX_PAGES_PER_UPLOAD = 75

export const RASTER_DPI = 150
export const RASTER_MAX_EDGE = 2200

export const MAX_PAGE_BYTES = 4 * 1024 * 1024
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024
export const MAX_PAGE_DIMENSION = 5000

/**
 * The largest page number a source document may have.
 *
 * Not the same thing as how many pages an upload may contain, and the two must
 * not be conflated. With a page range the client rasterizes pages 10 to 15 of a
 * PDF and sends `pageCount: 6` with `pageNumber` values 10 through 15, so
 * bounding the number by the count would refuse every ranged upload. This
 * bounds the number alone; `MAX_PAGES_PER_UPLOAD` and the worksheet's declared
 * `pageCount` bound how many arrive.
 *
 * Matches the ceiling `createSchema` puts on a declared `pageCount`, so no
 * worksheet can legitimately name a page above it.
 */
export const MAX_SOURCE_PAGE_NUMBER = 2000

/**
 * Pixels sharp will decode before refusing.
 *
 * A decompression bomb is a small file that expands to something enormous, so
 * the byte cap above says nothing about it. This is the real ceiling, set a
 * little above the largest legitimate page: MAX_PAGE_DIMENSION squared.
 */
export const MAX_DECODED_PIXELS = MAX_PAGE_DIMENSION * MAX_PAGE_DIMENSION

/*
 * There is deliberately no accepted-mime-type list here.
 *
 * There was one, and nothing read it. What decides whether a page is accepted
 * is `POST /api/worksheets/[id]/pages` handing the bytes to sharp: anything
 * that will not decode is refused there. That is the stronger check, and the
 * reason it replaced a type list is written up on the route: `file.type` is
 * whatever the client claimed it was, so a list of allowed values was checking
 * a string rather than an image.
 *
 * The file picker's `accept` attribute stays broader than any such list would
 * be (`application/pdf,image/*`), because narrowing it only hides files a
 * phone might legitimately produce, and the decode is what actually decides.
 */

export function pageCapFor(role: 'student' | 'admin'): number {
  return role === 'admin' ? Number.POSITIVE_INFINITY : MAX_PAGES_PER_UPLOAD
}
