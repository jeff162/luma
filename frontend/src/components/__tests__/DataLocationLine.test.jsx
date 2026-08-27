// @vitest-environment jsdom

// The nav pane's data-location line. What is worth pinning here is the gate, not the styling: the line
// is served only to a session the backend chose to tell, its default follows the installation, and an
// explicit preference overrides that default in *both* directions — a user who turned it off must not
// have it come back because the installation still qualifies.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UserPreferencesProvider } from '../../lib/UserPreferencesContext.jsx'
import { NAV_DATA_LOCATION_PREF_KEY } from '../../lib/dataLocation.js'
import DataLocationLine from '../DataLocationLine.jsx'

// This project doesn't run vitest with `globals: true`, so testing-library's automatic cleanup never
// registers — without this each render stacks another copy in document.body.
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const LOCATION = {
  db_path: '/home/someone/ledgers/household/luma-data.db',
  db_display_path: '~/ledgers/household/luma-data.db',
  control_db_path: '/home/someone/ledgers/household/luma-control.db',
  control_db_display_path: '~/ledgers/household/luma-control.db',
  show_by_default: true,
}

function renderLine({ dataLocation = LOCATION, initialPreferences = {} } = {}) {
  return render(
    <UserPreferencesProvider initialPreferences={initialPreferences}>
      <DataLocationLine dataLocation={dataLocation} />
    </UserPreferencesProvider>,
  )
}

function line() {
  return screen.queryByRole('button', { name: /Data location/ })
}

describe('the navigation pane data-location line', () => {
  it('states the shortened path when the installation qualifies', () => {
    renderLine()
    // The home prefix is the part every copy shares, so what is shown is the form the server shortened.
    expect(line().textContent).toContain('~/ledgers/household/luma-data.db')
  })

  it('renders nothing for a session the server did not tell', () => {
    // A member under sign-in protection gets no `data_location` field, and the client holds no second
    // copy of that rule — no data, no line.
    renderLine({ dataLocation: null })
    expect(line()).toBeNull()
  })

  it('stays hidden once the user has turned it off, however the installation reads', () => {
    renderLine({ initialPreferences: { [NAV_DATA_LOCATION_PREF_KEY]: false } })
    expect(line()).toBeNull()
  })

  it('appears when the user asked for it on an installation that would not offer it', () => {
    renderLine({
      dataLocation: { ...LOCATION, show_by_default: false },
      initialPreferences: { [NAV_DATA_LOCATION_PREF_KEY]: true },
    })
    expect(line()).toBeTruthy()
  })

  it('is absent by default on an ordinary installation at its default location', () => {
    renderLine({ dataLocation: { ...LOCATION, show_by_default: false } })
    expect(line()).toBeNull()
  })

  it('carries the full path, and the control database only when it sits elsewhere', async () => {
    const user = userEvent.setup()
    renderLine()
    await user.hover(line())
    // Absolute, not the shortened form: the tooltip is where the value is read to be used.
    expect(await screen.findByText('/home/someone/ledgers/household/luma-data.db')).toBeTruthy()
    expect(screen.queryByText(/Control database:/)).toBeNull()

    cleanup()
    renderLine({
      dataLocation: { ...LOCATION, control_db_path: '/var/lib/luma/luma-control.db' },
    })
    await user.hover(line())
    expect(await screen.findByText(/Control database: \/var\/lib\/luma\/luma-control\.db/)).toBeTruthy()
  })

  it('is laid out to elide at whatever width the pane has been dragged to', () => {
    // jsdom does no layout, so this pins the mechanism rather than the result: the pane is resizable,
    // which is why the fit is left to CSS — a JS truncation would be right at exactly one width. The
    // ellipsis is at the *start* so the tail survives, that being the half that differs between two
    // installations.
    renderLine()
    // The truncating element, not the button around it — a button's contents sit in an anonymous box
    // that sizes to them, so the styles only bite one level in.
    const { style } = screen.getByTestId('data-location-path')
    expect(style.overflow).toBe('hidden')
    expect(style.textOverflow).toBe('ellipsis')
    expect(style.whiteSpace).toBe('nowrap')
    expect(style.direction).toBe('rtl')
    // And the chain that gives it a width to elide against: a shrink-wrapping ancestor is what made
    // this render as an un-truncated path clipped by the pane.
    expect(line().parentElement.style.display).toBe('block')
    expect(line().style.width).toBe('100%')
  })

  it('copies the absolute path, not the shortened one', async () => {
    const user = userEvent.setup()
    // After `setup()`, deliberately: user-event installs a clipboard stub of its own, and a spy planted
    // before it would be the one thing this test never observes.
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderLine()

    await user.click(line())
    // `~` is readable but not pasteable everywhere the user is going with it.
    expect(writeText).toHaveBeenCalledWith('/home/someone/ledgers/household/luma-data.db')
  })
})
