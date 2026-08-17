export const READING_SHARE = 0.8
export const VERIFYING_AT = 0.8
export const CLASSIFYING_AT = 0.95

export type JobPhase = 'reading' | 'verifying' | 'classifying'

export function readingProgress(pageNumber: number, totalPages: number): number {
  if (totalPages <= 0) return 0
  return (pageNumber / totalPages) * READING_SHARE
}

export function phaseFor(progress: number): JobPhase {
  if (progress >= CLASSIFYING_AT) return 'classifying'
  if (progress >= VERIFYING_AT) return 'verifying'
  return 'reading'
}
