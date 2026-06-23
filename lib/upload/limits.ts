/**
 * Upload guards (spec §5.2, §2.1, §8).
 *
 * The page cap is a quota and admins are exempt. The size and dimension caps
 * are crash/abuse guards and apply to everyone, including admins — bypassing
 * them buys nothing and risks the GPU worker.
 */

/**
 * A real practice test runs past 100 pages, so a low cap rejects exactly the
 * material this is for. 75 covers a full SHSAT/SAT form; anything larger is
 * split, which is also better for the queue.
 */
export const MAX_PAGES_PER_UPLOAD = 75

/** Rasterization target. High enough for OCR, low enough to stay small. */
export const RASTER_DPI = 150
export const RASTER_MAX_EDGE = 2200

export const MAX_PAGE_BYTES = 4 * 1024 * 1024
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024
export const MAX_PAGE_DIMENSION = 5000

export const ACCEPTED_SOURCE_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const

export function pageCapFor(role: 'student' | 'admin'): number {
  return role === 'admin' ? Number.POSITIVE_INFINITY : MAX_PAGES_PER_UPLOAD
}

export function describePageCap(role: 'student' | 'admin'): string {
  return role === 'admin' ? 'no page limit' : `${MAX_PAGES_PER_UPLOAD} pages per upload`
}
