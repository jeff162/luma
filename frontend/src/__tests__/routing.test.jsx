// @vitest-environment jsdom

/*
 * The route table as a contract: which path renders which page, which params it hands over, and what
 * navigating through it does to history.
 *
 * The pages are stubbed. Nothing here is about what a page draws — it is about the table itself, which
 * has no other net under it: a path that stops resolving, a param that stops arriving, or a more
 * general route that starts swallowing a more specific one are all silent, and none of them is visible
 * to a test of the page that no longer loads.
 *
 * `MemoryRouter` keeps a real history stack, so the back-step affordances the app builds on
 * (`navigate(-1)`, and a route pushed then left) are exercised here rather than only in the browser.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate, useParams } from 'react-router-dom'

// Each stub reports the params it was given, so a route's identity and its capture are one assertion.
function stub(name) {
  return {
    default: function PageStub() {
      const params = useParams()
      return <div data-testid="page">{`${name}:${JSON.stringify(params)}`}</div>
    },
  }
}

vi.mock('../pages/Dashboard.jsx', () => stub('dashboard'))
vi.mock('../pages/Transactions.jsx', () => stub('transactions'))
vi.mock('../pages/Categories.jsx', () => stub('categories'))
vi.mock('../pages/Rules.jsx', () => stub('rules'))
vi.mock('../pages/Accounts.jsx', () => stub('accounts'))
vi.mock('../pages/Settings.jsx', () => stub('settings'))
vi.mock('../pages/ImportExport.jsx', () => stub('import-export'))
vi.mock('../pages/ImportRuleSuggestions.jsx', () => stub('rule-suggestions'))
vi.mock('../pages/Tasks.jsx', () => stub('tasks'))
vi.mock('../pages/Recurring.jsx', () => stub('recurring'))
vi.mock('../pages/Help.jsx', () => stub('help'))

const { default: AppRoutes } = await import('../AppRoutes.jsx')

afterEach(cleanup)

function mountAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  )
}

async function pageAt(path) {
  mountAt(path)
  return (await screen.findByTestId('page')).textContent
}

describe('the route table', () => {
  const routes = [
    ['/', 'dashboard'],
    ['/transactions', 'transactions'],
    ['/categories', 'categories'],
    ['/rules', 'rules'],
    ['/accounts', 'accounts'],
    ['/import-export', 'import-export'],
    ['/tasks', 'tasks'],
    ['/recurring', 'recurring'],
    ['/settings', 'settings'],
    ['/help', 'help'],
  ]

  it.each(routes)('renders %s', async (path, expected) => {
    expect(await pageAt(path)).toBe(`${expected}:{}`)
  })

  it('keeps a query string out of route matching', async () => {
    expect(await pageAt('/recurring?series=abc123')).toBe('recurring:{}')
  })
})

describe('the parameterized routes', () => {
  it('captures a batch id', async () => {
    expect(await pageAt('/import-export/batches/42/rule-suggestions'))
      .toBe('rule-suggestions:{"batchId":"42"}')
  })

  it('captures a profile id', async () => {
    expect(await pageAt('/import-export/profiles/p-7/rule-suggestions'))
      .toBe('rule-suggestions:{"profileId":"p-7"}')
  })

  it('captures a help topic', async () => {
    expect(await pageAt('/help/transaction-documents'))
      .toBe('help:{"topic":"transaction-documents"}')
  })

  // `/import-export` is a prefix of three longer paths, and the suggestions page is reached by both a
  // static path and two parameterized ones. Ranking, not declaration order, is what keeps the specific
  // ones from being swallowed — so it is worth an assertion rather than an assumption.
  it('prefers the specific path over the prefix it shares', async () => {
    expect(await pageAt('/import-export/rule-suggestions')).toBe('rule-suggestions:{}')
  })
})

describe('paths the table does not claim', () => {
  // There is no catch-all route: an unmatched path renders an empty content area rather than a "not
  // found" page. Pinned because it is a deliberate absence, and because a router upgrade that started
  // rendering something there should be noticed.
  it('renders nothing for an unknown path', () => {
    mountAt('/nope')
    expect(screen.queryByTestId('page')).toBeNull()
  })

  it('renders nothing for a partial parameterized path', () => {
    mountAt('/import-export/batches/42')
    expect(screen.queryByTestId('page')).toBeNull()
  })
})

describe('navigating through the table', () => {
  // A probe rather than a page stub: navigation and the resulting location are what is under test, and
  // both need a component sitting inside the router alongside the routes.
  function Probe({ onReady }) {
    const navigate = useNavigate()
    const location = useLocation()
    onReady({ navigate })
    return <div data-testid="location">{`${location.pathname}${location.search}`}</div>
  }

  function mountWithProbe(initial = '/') {
    const control = {}
    render(
      <MemoryRouter initialEntries={[initial]}>
        <Probe onReady={api => Object.assign(control, api)} />
        <AppRoutes />
      </MemoryRouter>,
    )
    return control
  }

  it('lands on the page it was sent to', async () => {
    const control = mountWithProbe('/')
    await act(async () => { control.navigate('/rules') })
    expect(screen.getByTestId('location').textContent).toBe('/rules')
    expect((await screen.findByTestId('page')).textContent).toBe('rules:{}')
  })

  it('carries a query string through a navigation', async () => {
    const control = mountWithProbe('/')
    await act(async () => { control.navigate('/recurring?series=abc123') })
    expect(screen.getByTestId('location').textContent).toBe('/recurring?series=abc123')
    expect((await screen.findByTestId('page')).textContent).toBe('recurring:{}')
  })

  // The back-step the Help viewer and the filter history both rely on.
  it('steps back to where it came from', async () => {
    const control = mountWithProbe('/transactions')
    await act(async () => { control.navigate('/help/importing') })
    expect(screen.getByTestId('location').textContent).toBe('/help/importing')

    await act(async () => { control.navigate(-1) })
    expect(screen.getByTestId('location').textContent).toBe('/transactions')
    expect((await screen.findByTestId('page')).textContent).toBe('transactions:{}')
  })

  // `replace` is how the app rewrites the landing route and clears consumed navigation state; the
  // difference from a push is invisible until something tries to step back over it.
  it('leaves no history entry behind a replacing navigation', async () => {
    const control = mountWithProbe('/transactions')
    await act(async () => { control.navigate('/rules') })
    await act(async () => { control.navigate('/settings', { replace: true }) })
    expect(screen.getByTestId('location').textContent).toBe('/settings')

    await act(async () => { control.navigate(-1) })
    expect(screen.getByTestId('location').textContent).toBe('/transactions')
  })
})
