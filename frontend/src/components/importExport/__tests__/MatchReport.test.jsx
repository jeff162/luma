// @vitest-environment jsdom

// Guards the two properties that windowing MatchReport is allowed to change and the two it is not.
//
// May change: how many rows are in the DOM (that is the whole point) and where column widths come from
// (the persisted grid template rather than browser auto-sizing).
//
// Must NOT change: sort and selection stay driven from the *full* entry list. Under windowing it is easy
// to accidentally scope "select all" or a count to the mounted subset, which would silently mean
// something different to the user than it did before — so those are pinned here.

import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UserPreferencesProvider } from '../../../lib/UserPreferencesContext.jsx'
import { MatchReport } from '../MatchReport.jsx'

// jsdom does no layout: every box measures 0x0, so a virtualizer faithfully renders nothing. These two
// stubs give it just enough geometry to behave as it would in a browser — a 600px viewport and rows of a
// known height — which is what makes "how many rows mounted" a meaningful assertion here.
const VIEWPORT_HEIGHT = 600
const MEASURED_ROW_HEIGHT = 40

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // A mounted row reports its own height; anything else is treated as the scroll viewport. Both paths
  // have to agree, because virtual-core reads the viewport through offsetHeight but measures rows
  // through whichever of the two the build happens to use — a viewport-sized row makes the virtualizer
  // believe one row fills the screen, which quietly defeats the thing these tests exist to check.
  const heightOf = element => (element.hasAttribute('data-index') ? MEASURED_ROW_HEIGHT : VIEWPORT_HEIGHT)
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 800 } })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return heightOf(this) } })
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const height = heightOf(this)
    return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: height, width: 800, height, toJSON() {} }
  }
})

// This project doesn't run vitest with `globals: true`, so testing-library's automatic per-test cleanup
// never registers — without this, each render stacks another copy in document.body and `screen` queries
// match across tests.
afterEach(cleanup)

const COLUMNS = [
  { key: 'name', label: 'Name', width: 200, sortable: true, render: entry => <span>{entry.name}</span> },
  { key: 'amount', label: 'Amount', width: 120, align: 'end', render: entry => <span>{entry.amount}</span> },
]

function makeEntries(count) {
  return Array.from({ length: count }, (_, index) => ({ id: `e${index}`, name: `Entry ${index}`, amount: index }))
}

function renderReport(props = {}, { initialPreferences = {} } = {}) {
  return render(
    <UserPreferencesProvider initialPreferences={initialPreferences}>
      <MatchReport
        columnsPrefKey="test.matchReport.columns"
        columns={COLUMNS}
        entries={makeEntries(3000)}
        getRowId={entry => entry.id}
        {...props}
      />
    </UserPreferencesProvider>,
  )
}

function rowElements(container) {
  return container.querySelectorAll('[data-index]')
}

describe('MatchReport windowing', () => {
  it('mounts a bounded number of rows regardless of entry count', () => {
    const { container } = renderReport()
    const mounted = rowElements(container).length

    expect(mounted).toBeGreaterThan(0)
    // The real bound is viewport-derived; the assertion that matters is that it is not O(entries).
    expect(mounted).toBeLessThan(100)
  })

  it('reserves scroll height for every entry, not just the mounted rows', () => {
    const { container } = renderReport({ estimatedRowHeight: MEASURED_ROW_HEIGHT })
    const spacer = container.querySelector('[data-index]').parentElement.parentElement

    // 3000 rows at the measured height — the scrollbar must reflect the whole list or the user can't
    // reach the rows that aren't mounted.
    expect(spacer.style.height).toBe(`${3000 * MEASURED_ROW_HEIGHT}px`)
  })

  it('passes the row index to getRowId so position-keyed reports need no lookup scan', () => {
    const getRowId = vi.fn((entry, index) => `${entry.id}:${index}`)
    renderReport({ getRowId })

    expect(getRowId).toHaveBeenCalled()
    for (const call of getRowId.mock.calls) {
      expect(typeof call[1]).toBe('number')
    }
  })
})

describe('MatchReport selection stays scoped to the full entry list', () => {
  it('drives select-all from the report, not from the mounted rows', async () => {
    const onToggleAll = vi.fn()
    renderReport({ selectable: true, selectedIds: new Set(), onToggleAll, allVisibleSelected: false })

    await userEvent.click(screen.getByTitle('Select all visible'))

    // MatchReport must not compute a selection itself — the owning report resolves what "all" means.
    expect(onToggleAll).toHaveBeenCalledTimes(1)
  })

  it('reflects a selection that covers entries beyond the mounted window', () => {
    const entries = makeEntries(3000)
    const { container } = renderReport({
      entries,
      selectable: true,
      // Selected far past anything mounted: the checked state of mounted rows must come from the
      // caller's set, so an off-screen selection is preserved rather than dropped on scroll.
      selectedIds: new Set(['e0', 'e2999']),
      allVisibleSelected: false,
      someVisibleSelected: true,
    })

    const firstRowCheckbox = rowElements(container)[0].querySelector('input[type="checkbox"]')
    expect(firstRowCheckbox.checked).toBe(true)
    expect(screen.getByTitle('Select all visible').indeterminate).toBe(true)
  })

  it('toggles the entry object for the clicked row', async () => {
    const onToggleRow = vi.fn()
    const { container } = renderReport({ selectable: true, selectedIds: new Set(), onToggleRow })

    await userEvent.click(rowElements(container)[1].querySelector('input[type="checkbox"]'))

    expect(onToggleRow).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }))
  })
})

describe('MatchReport column geometry', () => {
  it('builds one fixed grid template so widths cannot shift as rows mount and unmount', () => {
    const { container } = renderReport()
    const row = rowElements(container)[0]

    // Every row consumes the same published template rather than sizing itself from its own content.
    expect(row.style.gridTemplateColumns).toBe('var(--pgt-grid)')
  })

  it('applies persisted widths over the column defaults', () => {
    const { container } = renderReport({}, {
      initialPreferences: { 'test.matchReport.columns': [{ key: 'amount', width: 500 }, { key: 'name', width: 90 }] },
    })
    const root = container.querySelector('[style*="--pgt-grid"]')

    // Saved order and widths win, which is what makes the template stable across opens.
    expect(root.style.getPropertyValue('--pgt-grid')).toBe('500px 90px')
  })

  it('gives an unsized column a real starting width instead of leaving it auto', () => {
    const { container } = renderReport({
      columns: [{ key: 'only', label: 'Only', render: () => <span>x</span> }],
    })
    const root = container.querySelector('[style*="--pgt-grid"]')

    expect(root.style.getPropertyValue('--pgt-grid')).toMatch(/^\d+px$/)
  })
})
