import { expect, test } from '@playwright/test'

/*
 * Does the built app load, route and draw?
 *
 * Every assertion here is deliberately shallow. What breaks when a build dependency changes is not a
 * behaviour — it is a chunk that 404s, a route that stops resolving, a `define` that stops being
 * replaced, a vendor split that reorders an import. Those turn the whole screen blank, and none of them
 * is visible to a unit test or to a suite driving the dev server. Anything subtler than "the page came
 * up" belongs in the specs next door, against a stack that is far quicker to run.
 *
 * The page is judged three ways at once, because a broken bundle announces itself differently depending
 * on where it broke: the route resolved (the nav marks itself current), something rendered (a heading),
 * and nothing complained (no console error, no failed request, no error boundary).
 */

// Every route in the table, with the nav label that proves it resolved. The parameterized routes are
// covered by the unit suite; what matters here is that each lazily-loaded page chunk arrives at all.
const PAGES = [
  ['/', 'Dashboard'],
  ['/transactions', 'Transactions'],
  ['/categories', 'Categories'],
  ['/rules', 'Rules'],
  ['/accounts', 'Accounts'],
  ['/recurring', 'Recurring'],
  ['/import-export', 'Import / Export'],
  ['/tasks', 'Tasks'],
  ['/settings', 'Settings'],
  ['/help', 'Help'],
]

// Noise a healthy page still produces. Kept as narrow as possible: the value of this pass is that it
// fails when something is wrong, and every entry here is a hole in that.
const IGNORED_CONSOLE = [
  /favicon/i,
  /Download the React DevTools/i,
]

function watchForTrouble(page) {
  const problems = []
  page.on('console', message => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (IGNORED_CONSOLE.some(pattern => pattern.test(text))) return
    problems.push(`console: ${text}`)
  })
  page.on('pageerror', error => problems.push(`uncaught: ${error.message}`))
  page.on('response', response => {
    if (response.status() >= 400 && !/favicon/i.test(response.url())) {
      problems.push(`${response.status()} ${response.url()}`)
    }
  })
  return problems
}

test.describe('the built bundle', () => {
  for (const [path, navLabel] of PAGES) {
    test(`serves ${path}`, async ({ page }) => {
      const problems = watchForTrouble(page)

      // "/" is the one route the app may redirect away from — the remembered startup route is applied
      // there and only there — so it is reached the way a user reaches it, by clicking the nav.
      if (path === '/') {
        await page.goto('/')
        await page.getByRole('link', { name: navLabel }).click()
      } else {
        await page.goto(path)
      }

      // React Router marks the active NavLink, so this says the route resolved and the chunk behind it
      // loaded — without depending on any wording inside the page.
      await expect(page.getByRole('link', { name: navLabel })).toHaveAttribute('aria-current', 'page')
      await expect(page.locator('h1').first()).toBeVisible()
      await expect(page.getByText('Something went wrong')).toHaveCount(0)

      expect(problems, `${path} reported problems`).toEqual([])
    })
  }
})

test('draws a chart against real data', async ({ page }) => {
  // Recharts is the largest dependency and rides in its own manually-split chunk, which makes it the
  // first thing a chunking change breaks. An empty dashboard would render happily without it, so this
  // needs the demo data the global setup loads.
  const problems = watchForTrouble(page)
  await page.goto('/')
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await expect(page.locator('svg.recharts-surface').first()).toBeVisible()
  expect(problems, 'the dashboard reported problems').toEqual([])
})

test('keeps working across a client-side navigation and a reload', async ({ page }) => {
  // Two different mechanisms, both invisible to the unit suite. The first is real history rather than
  // `MemoryRouter`; the second leaves the SPA entirely and comes back through the backend's fallback,
  // which is the only thing that proves a deep link survives a refresh.
  const problems = watchForTrouble(page)
  await page.goto('/transactions')
  await page.getByRole('link', { name: 'Rules' }).click()
  await expect(page.getByRole('link', { name: 'Rules' })).toHaveAttribute('aria-current', 'page')

  await page.goBack()
  await expect(page.getByRole('link', { name: 'Transactions' })).toHaveAttribute('aria-current', 'page')

  await page.reload()
  await expect(page.getByRole('link', { name: 'Transactions' })).toHaveAttribute('aria-current', 'page')
  expect(problems, 'navigation reported problems').toEqual([])
})
