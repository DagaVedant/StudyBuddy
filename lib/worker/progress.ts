/**
 * Where each phase of a job sits on the 0..1 progress bar.
 *
 * Reading the pages is the long part but not the last part: afterwards the
 * audit re-reads whatever the extraction missed, and then every question gets
 * a topic. Both of those used to run with progress already at 1, so the bar
 * sat full — sometimes for a while — while the app still had work to do, which
 * reads as a hang. Reading now stops short and leaves the rest of the bar for
 * the stages that follow.
 */
export const READING_SHARE = 0.8
export const VERIFYING_AT = 0.8
export const CLASSIFYING_AT = 0.95

export type JobPhase = 'reading' | 'verifying' | 'classifying'

/** Scales page-reading progress into the slice of the bar it owns. */
export function readingProgress(pageNumber: number, totalPages: number): number {
  if (totalPages <= 0) return 0
  return (pageNumber / totalPages) * READING_SHARE
}

export function phaseFor(progress: number): JobPhase {
  if (progress >= CLASSIFYING_AT) return 'classifying'
  if (progress >= VERIFYING_AT) return 'verifying'
  return 'reading'
}
