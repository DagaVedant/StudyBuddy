import { describe, expect, it } from 'vitest'

import { evidenceFor } from '@/lib/questions/evidence'

/**
 * Which questions can be shown their own figure, and which must not be.
 *
 * Every rejection here degrades to no image rather than a wrong one. On a
 * screen whose job is answering a question about a diagram, a crop of the
 * wrong part of the page is worse than none: it looks like the figure and it
 * is not.
 */
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

  // The bbox is in the page image's own pixels, so a page that never recorded
  // its size gives nothing to measure against and the crop lands anywhere.
  it('refuses a page that never recorded its size', () => {
    expect(evidenceFor([100, 200, 900, 700], { ...page, width: null })).toBeNull()
    expect(evidenceFor([100, 200, 900, 700], { ...page, height: null })).toBeNull()
    expect(evidenceFor([100, 200, 900, 700], { ...page, width: 0 })).toBeNull()
  })

  // Both come back from extraction. Neither can be cropped to.
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

  // Overlapping an edge is not falling off it. A question printed hard against
  // the margin has a box that starts left of zero, and it is still the right
  // crop; the component clamps the window.
  it('keeps a box that overlaps an edge', () => {
    expect(evidenceFor([-20, 200, 900, 700], page)).not.toBeNull()
    expect(evidenceFor([100, 200, 1400, 700], page)).not.toBeNull()
  })
})
