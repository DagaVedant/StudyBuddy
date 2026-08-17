import { describe, expect, it } from 'vitest'

import { destination } from '@/lib/worksheets/destination'

const extracted = (status: string, markedCount = 0) => ({
  status,
  questionCount: 12,
  markedCount,
})

describe('destination', () => {
  it.each(['uploading', 'queued', 'processing'])(
    'sends a worksheet that is still %s to the status screen',
    (status) => {
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
      '/worksheets/w1/check',
    )
  })

  it('sends one awaiting review with nothing extracted to the editor instead', () => {
    const { href, cta } = destination('w1', {
      status: 'awaiting_review',
      questionCount: 0,
      markedCount: 0,
    })

    expect(href).toBe('/worksheets/w1/edit')
    expect(cta).toBe('Add questions')
  })

  it('offers marking on a finished worksheet that has never been marked', () => {
    const { href, cta } = destination('w1', extracted('ready'))

    expect(href).toBe('/worksheets/w1/markup')
    expect(cta).toBe('Mark answers')
  })

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
