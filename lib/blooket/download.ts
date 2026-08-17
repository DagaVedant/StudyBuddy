import { NextResponse } from 'next/server'

import { exportFilename, toBlooketCsv, type ExportQuestion } from './csv'

export function blooketDownload(
  missed: ExportQuestion[],
  title?: string,
): NextResponse {
  const { csv, included, skipped } = toBlooketCsv(missed)

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
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${exportFilename(
        new Date().toISOString().slice(0, 10),
        title,
      )}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Export-Included': String(included),
      'X-Export-Skipped': String(skipped.length),
    },
  })
}
