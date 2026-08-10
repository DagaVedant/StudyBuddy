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
 * One function, so the two lists cannot drift again.
 */
export function destination(
  id: string,
  status: string,
  marked: boolean,
): { href: string; cta: string } {
  switch (status) {
    case 'uploading':
    case 'queued':
    case 'processing':
      return { href: `/worksheets/${id}/status`, cta: 'Processing' }
    case 'awaiting_review':
      return { href: `/worksheets/${id}/verify`, cta: 'Check questions' }
    case 'failed':
      return { href: `/worksheets/${id}/status`, cta: 'See what happened' }
    default:
      // Marking happens once per paper, so a marked worksheet stops offering
      // it and points at what comes next instead.
      return marked
        ? { href: '/review', cta: 'Practice' }
        : { href: `/worksheets/${id}/markup`, cta: 'Mark answers' }
  }
}
