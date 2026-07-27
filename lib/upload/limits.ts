export const MAX_PAGES_PER_UPLOAD = 75

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
