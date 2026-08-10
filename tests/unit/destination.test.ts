import { describe, expect, it } from 'vitest'

import { destination } from '@/lib/worksheets/destination'

/**
 * Two screens list worksheets and both used to decide this for themselves. They
 * agreed only on the `ready` case; everything else went somewhere different
 * depending on which list you clicked from.
 */
describe('destination', () => {
  it.each(['uploading', 'queued', 'processing'])(
    'sends a worksheet that is still %s to the status screen',
    (status) => {
      // Not `/markup`, which is where the dashboard used to send these. There is
      // nothing to mark on a paper whose questions have not been read yet, and
      // the marking screen is the one place that will happily act on a
      // half-ingested worksheet.
      expect(destination('w1', status, false).href).toBe('/worksheets/w1/status')
    },
  )

  it('sends a failed worksheet somewhere that explains itself', () => {
    const { href, cta } = destination('w1', 'failed', false)

    expect(href).toBe('/worksheets/w1/status')
    expect(cta).toBe('See what happened')
  })

  it('sends one awaiting review to the check screen, not the practice queue', () => {
    expect(destination('w1', 'awaiting_review', false).href).toBe('/worksheets/w1/verify')
  })

  it('offers marking on a finished worksheet that has never been marked', () => {
    const { href, cta } = destination('w1', 'ready', false)

    expect(href).toBe('/worksheets/w1/markup')
    expect(cta).toBe('Mark answers')
  })

  it('moves on to practice once it has been marked, since marking happens once', () => {
    const { href, cta } = destination('w1', 'ready', true)

    expect(href).toBe('/review')
    expect(cta).toBe('Practice')
  })

  it('treats a status it has never heard of as finished rather than as broken', () => {
    expect(destination('w1', 'something-new', false).href).toBe('/worksheets/w1/markup')
  })
})
