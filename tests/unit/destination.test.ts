import { describe, expect, it } from 'vitest'

import { destination } from '@/lib/worksheets/destination'

/**
 * Three screens send a student to a worksheet and all of them used to decide
 * this for themselves. The two lists agreed only on the `ready` case; the
 * status page, where an upload lands, disagreed with both.
 */

/** A worksheet whose questions were extracted normally. */
const extracted = (status: string, markedCount = 0) => ({
  status,
  questionCount: 12,
  markedCount,
})

describe('destination', () => {
  it.each(['uploading', 'queued', 'processing'])(
    'sends a worksheet that is still %s to the status screen',
    (status) => {
      // Not `/markup`, which is where the dashboard used to send these. There is
      // nothing to mark on a paper whose questions have not been read yet, and
      // the marking screen is the one place that will happily act on a
      // half-ingested worksheet.
      expect(destination('w1', extracted(status)).href).toBe('/worksheets/w1/status')
    },
  )

  it('sends a failed worksheet somewhere that explains itself', () => {
    const { href, cta } = destination('w1', extracted('failed'))

    expect(href).toBe('/worksheets/w1/status')
    expect(cta).toBe('See what happened')
  })

  it('sends one awaiting review to the check screen, not the practice queue', () => {
    expect(destination('w1', extracted('awaiting_review')).href).toBe(
      '/worksheets/w1/verify',
    )
  })

  it('sends one awaiting review with nothing extracted to the editor instead', () => {
    // An exhausted trial lands here: `POST /complete` refuses the charge and
    // drops the worksheet to `awaiting_review` with no questions at all, for
    // the student to type in by hand. /verify would answer "This worksheet has
    // no questions to check." and offer no way to add one, so a card for this
    // worksheet was a dead end for anyone past their trial.
    const { href, cta } = destination('w1', {
      status: 'awaiting_review',
      questionCount: 0,
      markedCount: 0,
    })

    expect(href).toBe('/worksheets/w1/review')
    expect(cta).toBe('Add questions')
  })

  it('offers marking on a finished worksheet that has never been marked', () => {
    const { href, cta } = destination('w1', extracted('ready'))

    expect(href).toBe('/worksheets/w1/markup')
    expect(cta).toBe('Mark answers')
  })

  /**
   * Still the worksheet's own screen once marked, where it used to be the
   * global practice queue. That queue is a different set of questions from this
   * paper and already has a nav item; sending a card there also left the
   * per-question correction with no route into it at all.
   */
  it('keeps a marked worksheet pointed at its own marks', () => {
    const { href, cta } = destination('w1', extracted('ready', 40))

    expect(href).toBe('/worksheets/w1/markup')
    expect(cta).toBe('See your marks')
  })

  it('says which of the two the markup screen will show', () => {
    expect(destination('w1', extracted('ready', 0)).cta).toBe('Mark answers')
    expect(destination('w1', extracted('ready', 40)).cta).toBe('See your marks')
  })

  it('treats a status it has never heard of as finished rather than as broken', () => {
    expect(destination('w1', extracted('something-new')).href).toBe(
      '/worksheets/w1/markup',
    )
  })
})
