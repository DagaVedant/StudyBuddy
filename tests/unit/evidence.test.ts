import { describe, expect, it } from 'vitest'

import { evidenceFor } from '@/lib/questions/evidence'

describe('evidenceFor', () => {
  const page = { imageKey: 'pages/one.png', width: 1275, height: 1650 }

  it('places a box that sits on the page', () => {
    expect(evidenceFor([100, 200, 900, 700], page)).toEqual({
      src: '/api/files/pages/one.png',
      width: 1275,
      height: 1650,
      bbox: [100, 200, 900, 700],
    })
  })

  it('refuses a question with no box', () => {
    expect(evidenceFor(null, page)).toBeNull()
  })

  it('refuses a question with no page, which is one added by hand', () => {
    expect(evidenceFor([100, 200, 900, 700], undefined)).toBeNull()
  })

  it('refuses a page that never recorded its size', () => {
    expect(evidenceFor([100, 200, 900, 700], { ...page, width: null })).toBeNull()
    expect(evidenceFor([100, 200, 900, 700], { ...page, height: null })).toBeNull()
    expect(evidenceFor([100, 200, 900, 700], { ...page, width: 0 })).toBeNull()
  })

  it('refuses a box with no area', () => {
    expect(evidenceFor([500, 500, 500, 900], page)).toBeNull()
    expect(evidenceFor([500, 500, 900, 500], page)).toBeNull()
  })

  it('refuses a box inverted by the reader', () => {
    expect(evidenceFor([900, 700, 100, 200], page)).toBeNull()
  })

  it('refuses a box that falls off the page', () => {
    expect(evidenceFor([1300, 200, 1400, 700], page)).toBeNull()
    expect(evidenceFor([100, 1700, 900, 1800], page)).toBeNull()
    expect(evidenceFor([-200, 200, -10, 700], page)).toBeNull()
  })

  it('keeps a box that overlaps an edge', () => {
    expect(evidenceFor([-20, 200, 900, 700], page)).not.toBeNull()
    expect(evidenceFor([100, 200, 1400, 700], page)).not.toBeNull()
  })
})
