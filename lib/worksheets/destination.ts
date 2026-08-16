/**
 * Where a worksheet card should take you, and what the link should say.
 *
 * Both places that list worksheets used to work this out for themselves, and
 * they disagreed on every status that is not `ready`. The dashboard sent an
 * uploading, queued, processing or failed worksheet straight to `/markup`,
 * which is the screen for recording which answers you got wrong. On a paper
 * that is still being read that screen has nothing to mark, and on a failed one
 * it never will have; both skip past the status page, which is the only screen
 * that says what is happening or what went wrong. It also sent a paper awaiting
 * review to `/review`, the practice queue, rather than to the check-the-
 * questions screen it actually needed.
 *
 * One function, so the two lists cannot drift again. The status page counts as
 * a third list for this purpose: it is where an upload lands, and it used to
 * pick its own destination, so the same worksheet in the same state opened one
 * screen from an upload and a different one from a card.
 */
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
      // `awaiting_review` covers two different papers. Normally it means
      // questions were extracted and want checking, which is /verify's whole
      // job. But a student past their trial gets here with nothing extracted
      // at all: `POST /complete` refuses the charge, drops the worksheet to
      // this same status with `mode: 'manual'`, and sends them to the editor
      // to type the paper in by hand. Routing that one to /verify reaches
      // "This worksheet has no questions to check.", which is true and is a
      // dead end, because that screen has no way to add one. It was reachable
      // from any card on the dashboard or the library the moment the student
      // navigated away and came back.
      return worksheet.questionCount > 0
        ? { href: `/worksheets/${id}/verify`, cta: 'Check questions' }
        : { href: `/worksheets/${id}/review`, cta: 'Add questions' }
    case 'failed':
      return { href: `/worksheets/${id}/status`, cta: 'See what happened' }
    default:
      // Marking happens once per paper, so a marked worksheet stops offering
      // it and points at what comes next instead.
      return worksheet.markedCount > 0
        ? { href: '/review', cta: 'Practice' }
        : { href: `/worksheets/${id}/markup`, cta: 'Mark answers' }
  }
}
