import { describe, it, expect } from 'vitest'
import { MIN_NAMED_SLICES, computeSlicePages } from '../longTailSlices.js'

const rows = totals => totals.map((total, i) => ({ name: `r${i}`, total }))

// Pages are half-open [start, end) index ranges over a magnitude-sorted list; the first page's `end` is
// how many buckets get named before the rest collapse into Other.
const namedCount = pages => pages[0].end

describe('computeSlicePages without a minimum share', () => {
  it('names every bucket when there are fewer than the floor, however small they are', () => {
    // The behaviour the pies rely on, and the reason the cash-flow diagram needed an opt-in floor: a
    // short side never reaches the peeling threshold, so a 0.0004% bucket is still given a name.
    const pages = computeSlicePages(rows([84604.5, 33610.91, 6296.59, 900, 300, 120, 40, 0.55]))
    expect(pages).toEqual([{ start: 0, end: 8 }])
  })

  it('peels the long tail once the next bucket falls under the share threshold', () => {
    const pages = computeSlicePages(rows([100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 1, 1, 1]))
    expect(namedCount(pages)).toBe(MIN_NAMED_SLICES)
    expect(pages.length).toBeGreaterThan(1)
  })
})

describe('computeSlicePages with a minimum share', () => {
  const tinyTail = rows([84604.5, 33610.91, 6296.59, 900, 300, 120, 40, 0.55])

  it('refuses to name a bucket under the floor even below the minimum-named count', () => {
    const pages = computeSlicePages(tinyTail, { minShare: 0.01 })
    // 67.2%, 26.7% and 5.0% clear one percent of the side; everything after is dust.
    expect(namedCount(pages)).toBe(3)
  })

  it('leaves the totals alone — it only decides what is drawn separately', () => {
    const pages = computeSlicePages(tinyTail, { minShare: 0.01 })
    const covered = pages.reduce((sum, p) => sum + (p.end - p.start), 0)
    expect(covered).toBe(tinyTail.length)
    expect(pages[0].start).toBe(0)
    expect(pages[pages.length - 1].end).toBe(tinyTail.length)
  })

  it('recomputes the floor against each deeper page rather than the original pool', () => {
    // The tail's own shares are much larger once the giants are gone, so drilling keeps making progress
    // instead of stranding the user on a page where everything is under the floor again.
    const pages = computeSlicePages(tinyTail, { minShare: 0.01 })
    expect(pages.length).toBeGreaterThan(1)
    expect(pages[1].end).toBeGreaterThan(pages[1].start)
  })

  it('always names at least one bucket, so paging terminates and stays clickable', () => {
    // A pool flat enough that no single member reaches the floor. Naming none of them would leave the
    // page empty and the loop unable to advance.
    const flat = rows(Array.from({ length: 300 }, () => 1))
    const pages = computeSlicePages(flat, { minShare: 0.5 })
    expect(pages.every(p => p.end > p.start)).toBe(true)
    expect(pages[pages.length - 1].end).toBe(flat.length)
  })

  it('changes nothing when the option is omitted', () => {
    expect(computeSlicePages(tinyTail)).toEqual(computeSlicePages(tinyTail, {}))
    expect(computeSlicePages(tinyTail)).toEqual([{ start: 0, end: 8 }])
  })

  it('still absorbs a lone leftover rather than showing a one-item Other', () => {
    // Nine clearly-named buckets and one just under the floor: naming it beats an "Other (1)" that costs
    // the same label row and says less.
    const pages = computeSlicePages(rows([100, 100, 100, 100, 100, 100, 100, 100, 100, 1]), { minShare: 0.01 })
    expect(pages).toEqual([{ start: 0, end: 10 }])
  })
})
