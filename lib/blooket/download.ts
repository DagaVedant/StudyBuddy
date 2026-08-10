import { NextResponse } from 'next/server'

import { exportFilename, toBlooketCsv, type ExportQuestion } from './csv'

/**
 * The file, as the two export routes hand it back.
 *
 * Shared because the routes differ only in which questions they gather and what
 * the file ends up called. Everything below that point, and in particular the
 * empty case, has to answer the same way whichever door it came through.
 */
export function blooketDownload(
  missed: ExportQuestion[],
  title?: string,
): NextResponse {
  const { csv, included, skipped } = toBlooketCsv(missed)

  // An importable file with no questions in it is worse than no file: Blooket
  // accepts it, reports nothing, and creates an empty set. Both entry points
  // are only offered when there is something to export, so reaching here means
  // the link was followed directly, or every question was dropped for want of
  // an answer key. Those are different problems and get different sentences.
  if (included === 0) {
    return new NextResponse(
      skipped.length > 0
        ? 'None of the questions you missed have an answer key, so there is nothing Blooket could score.'
        : 'Nothing to export yet.',
      { status: 404 },
    )
  }

  return new NextResponse(csv, {
    headers: {
      // Blooket only accepts .csv on upload, whatever its template downloads as.
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${exportFilename(
        new Date().toISOString().slice(0, 10),
        title,
      )}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // What the file actually holds, for anyone reconciling it against the
      // count on screen. `skipped` is almost always questions with no answer
      // key, which Blooket has no way to host.
      'X-Export-Included': String(included),
      'X-Export-Skipped': String(skipped.length),
    },
  })
}
