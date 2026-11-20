// @vitest-environment jsdom

// Pins the contract every long list in the app now depends on: only the rows near the viewport are
// mounted, the scroll spacer still reserves height for all of them, and item *identity* (not list
// position) keys the measurement cache so a re-sort doesn't reuse the previous row's height at an index.

import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { useRef } from 'react'
import WindowedRows from '../WindowedRows.jsx'
import { installFakeLayout } from '../../test-support/fakeLayout.js'

const VIEWPORT_HEIGHT = 600
const ROW_HEIGHT = 40

beforeAll(() => installFakeLayout({ viewportHeight: VIEWPORT_HEIGHT, rowHeight: ROW_HEIGHT }))

afterEach(cleanup)

function Harness({ items, getItemKey = item => item.id, renderRow, estimateSize = ROW_HEIGHT, apiRef, onTopIndexChange, onRangeChange }) {
  const scrollRef = useRef(null)
  return (
    <div ref={scrollRef} style={{ overflow: 'auto', height: VIEWPORT_HEIGHT }}>
      <WindowedRows
        scrollRef={scrollRef}
        items={items}
        getItemKey={getItemKey}
        estimateSize={estimateSize}
        apiRef={apiRef}
        onTopIndexChange={onTopIndexChange}
        onRangeChange={onRangeChange}
        renderRow={renderRow ?? (item => <div>{item.label}</div>)}
      />
    </div>
  )
}

function makeItems(count) {
  return Array.from({ length: count }, (_, i) => ({ id: `r${i}`, label: `Row ${i}` }))
}

function rows(container) {
  return container.querySelectorAll('[data-index]')
}

describe('WindowedRows', () => {
  it('mounts only a viewport-bounded slice of a large list', () => {
    const { container } = render(<Harness items={makeItems(5000)} />)
    const mounted = rows(container).length

    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThan(100)
  })

  it('reserves scroll height for the whole list, not just the mounted rows', () => {
    const { container } = render(<Harness items={makeItems(5000)} />)
    // The measured [data-index] wrapper's grandparent is the full-height spacer.
    const spacer = rows(container)[0].parentElement.parentElement

    expect(spacer.style.height).toBe(`${5000 * ROW_HEIGHT}px`)
  })

  it('passes both the item and its index to renderRow', () => {
    const renderRow = vi.fn((item, index) => <div>{item.label}:{index}</div>)
    render(<Harness items={makeItems(20)} renderRow={renderRow} />)

    expect(renderRow).toHaveBeenCalled()
    for (const call of renderRow.mock.calls) {
      expect(call[0]).toHaveProperty('id')
      expect(typeof call[1]).toBe('number')
    }
  })

  it('keys the mounted rows by item identity so the cache survives a reorder', () => {
    const items = makeItems(20)
    const getItemKey = vi.fn(item => item.id)
    render(<Harness items={items} getItemKey={getItemKey} />)

    // The virtualizer must consult the caller's key function rather than falling back to the index.
    expect(getItemKey).toHaveBeenCalled()
    expect(getItemKey.mock.calls.some(call => call[0] && call[0].id)).toBe(true)
  })

  it('renders nothing extra for an empty list', () => {
    const { container } = render(<Harness items={[]} />)

    expect(rows(container).length).toBe(0)
  })

  it('exposes scrollToIndex through apiRef for a jump-nav', () => {
    const apiRef = { current: null }
    render(<Harness items={makeItems(200)} apiRef={apiRef} />)

    expect(apiRef.current).not.toBeNull()
    expect(typeof apiRef.current.scrollToIndex).toBe('function')
    expect(() => apiRef.current.scrollToIndex(120, { align: 'start' })).not.toThrow()
  })

  it('reports the top item index via onTopIndexChange', () => {
    const onTopIndexChange = vi.fn()
    render(<Harness items={makeItems(200)} onTopIndexChange={onTopIndexChange} />)

    expect(onTopIndexChange).toHaveBeenCalled()
    expect(onTopIndexChange.mock.calls.every(call => typeof call[0] === 'number')).toBe(true)
    // At rest (scrollOffset 0) the topmost item is index 0.
    expect(onTopIndexChange.mock.calls[0][0]).toBe(0)
  })

  it('reports the viewport range, without overscan, via onRangeChange', () => {
    const onRangeChange = vi.fn()
    render(<Harness items={makeItems(200)} onRangeChange={onRangeChange} />)

    expect(onRangeChange).toHaveBeenCalledTimes(1)
    expect(onRangeChange.mock.calls[0][0]).toEqual({ startIndex: 0, endIndex: VIEWPORT_HEIGHT / ROW_HEIGHT - 1 })
  })

  it('draws a placeholder for an unloaded item and nothing for an empty one, never handing either to the caller', () => {
    const items = [{ id: 'r0', label: 'Row 0' }, undefined, null]
    const renderRow = vi.fn(item => <div>{item.label}</div>)
    const getItemKey = vi.fn(item => item.id)
    const { container } = render(<Harness items={items} getItemKey={getItemKey} renderRow={renderRow} />)

    expect(rows(container)).toHaveLength(3)
    expect(container.textContent).toBe('Row 0')
    expect(rows(container)[1].firstChild).not.toBeNull()
    expect(rows(container)[2].firstChild).toBeNull()
    expect(renderRow.mock.calls.every(call => call[0])).toBe(true)
    expect(getItemKey.mock.calls.every(call => call[0])).toBe(true)
  })
})
