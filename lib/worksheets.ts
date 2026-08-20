export function destination(
  id: string,
  worksheet: { status: string; questionCount: number; markedCount: number },
): { href: string; cta: string } {
  switch (worksheet.status) {
    case 'uploading':
    case 'queued':
    case 'processing':
      return { href: `/worksheets/${id}/status`, cta: 'Processing' }
    case 'awaiting_review':
      return worksheet.questionCount > 0
        ? { href: `/worksheets/${id}/check`, cta: 'Check questions' }
        : { href: `/worksheets/${id}/edit`, cta: 'Add questions' }
    case 'failed':
      return { href: `/worksheets/${id}/status`, cta: 'See what happened' }
    default:
      return worksheet.markedCount > 0
        ? { href: `/worksheets/${id}/markup`, cta: 'See your marks' }
        : { href: `/worksheets/${id}/markup`, cta: 'Mark answers' }
  }
}
