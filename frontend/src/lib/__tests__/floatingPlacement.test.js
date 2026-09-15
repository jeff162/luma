import { describe, it, expect } from 'vitest'
import { alignOnAxis, besideOnAxis } from '../floatingPlacement.js'

describe('alignOnAxis', () => {
  it('keeps the requested start when the card fits', () => {
    expect(alignOnAxis({ start: 100, size: 200, lo: 0, hi: 1000 })).toBe(100)
  })
  it('slides a card that overhangs either edge back inside, keeping the margin', () => {
    expect(alignOnAxis({ start: 900, size: 200, lo: 0, hi: 1000 })).toBe(792)
    expect(alignOnAxis({ start: -40, size: 200, lo: 0, hi: 1000 })).toBe(8)
  })
  it('pins a card larger than the space to its start', () => {
    expect(alignOnAxis({ start: 50, size: 400, lo: 100, hi: 300 })).toBe(108)
  })
})

describe('besideOnAxis', () => {
  it('goes after the anchor when there is room', () => {
    expect(besideOnAxis({ before: 100, after: 120, size: 50, lo: 0, hi: 1000 })).toBe(126)
  })
  it('flips before the anchor when after would overhang', () => {
    expect(besideOnAxis({ before: 900, after: 950, size: 100, lo: 0, hi: 1000 })).toBe(794)
  })
  it('flips around a point near the far edge of a bounded space, not the far edge of the page', () => {
    // A cursor 14px inside the right edge of a visible chart area that ends at 600.
    expect(besideOnAxis({ before: 586, after: 586, size: 140, lo: 200, hi: 600, gap: 12 })).toBe(434)
  })
  it('clamps inside when the anchor lies past the far edge, instead of flipping to just before it', () => {
    // The hovered bar's centre (604) is already scrolled out of a visible area ending at 569. Flipping
    // before it lands at 433..592, past that edge — the defect the in-page check caught.
    expect(besideOnAxis({ before: 604, after: 604, size: 159, lo: 349, hi: 569, gap: 12 })).toBe(402)
  })
  it('does not go after an anchor that lies before the near edge', () => {
    expect(besideOnAxis({ before: 300, after: 300, size: 100, lo: 349, hi: 900, gap: 12 })).toBe(357)
  })
  it('clamps inside the bounds when neither side fits', () => {
    expect(besideOnAxis({ before: 60, after: 90, size: 120, lo: 0, hi: 200 })).toBe(72)
  })
})
