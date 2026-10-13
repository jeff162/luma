import { expect, test } from '@playwright/test'

// The dashboard's cash-flow frame: where the money came from and where it went, as one picture.
//
// It is the only dashboard frame that is not a variation on the other two — the pie and the trend chart
// both answer "how much", while this answers "from what, to what", and it draws an SVG diagram rather
// than reusing the chart components. That makes it the frame most likely to break quietly on a chart or
// bundler upgrade, and the one nothing else here covers.
//
// Reached through the Dashboard nav link rather than goto('/') for the reason dashboard.spec.js gives:
// the startup-route preference is shared across parallel specs on the one demo DB, so "/" is not
// reliably the dashboard.
test('the cash flow frame draws the flow diagram over demo data', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await page.getByRole('button', { name: 'Cash flow' }).click()

  // Three totals rather than the other frames' one or two: on this axis the net is a real figure, and
  // it is signed, so a period that spent more than it took in reads negative.
  await expect(page.getByText(/^Money out · /)).toBeVisible()
  await expect(page.getByText(/^Money in · /)).toBeVisible()
  await expect(page.getByText(/^Net · /)).toBeVisible()

  // The diagram itself, and the control that chooses what it breaks down by.
  await expect(page.getByText('Cash flow by')).toBeVisible()
  const diagram = page.locator('svg').filter({ has: page.locator('text') }).first()
  await expect(diagram).toBeVisible()

  // The demo's ledger spans more than a year, so the period has movement in it. The empty state saying
  // otherwise would mean the graph was built but came out with nothing in it — a silent failure that
  // still renders a page.
  await expect(
    page.getByText('Nothing moved in or out in this period, once transfers are excluded.'),
  ).toHaveCount(0)
})

// The cash-flow Trends form draws the years above the months, and a year is the way into its months:
// clicking one sets the year picker, which is what the monthly chart below follows.
test('the cash flow trends form opens a year into its months', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await page.getByRole('button', { name: 'Cash flow' }).click()
  await page.getByRole('button', { name: 'Trends' }).click()

  // Each card as the innermost element holding both its title and a chart. Taking the title's parent
  // instead broke the moment the title gained a control beside it (the trend-span chooser) and became a
  // header row of its own, which is a change to the card's layout rather than to what it draws.
  const card = title => page.locator('div')
    .filter({ has: page.getByText(title, { exact: true }) })
    .filter({ has: page.locator('.recharts-wrapper') })
    .last()
  const yearCard = card('Yearly trend')
  const monthCard = card('Monthly trend')
  const picker = page.locator('select').filter({ has: page.locator('option', { hasText: 'Last 12 months' }) })
  await expect(picker).toHaveValue('last12')

  // The newest year: the demo ledger's earlier year holds too little to draw a bar worth clicking.
  const year = await yearCard.locator('.recharts-xAxis-tick-labels text').last().textContent()
  await yearCard.locator('.recharts-bar-rectangle').last().click()
  await expect(picker).toHaveValue(year)
  const monthTicks = await monthCard.locator('.recharts-xAxis-tick-labels text').allTextContents()
  expect(monthTicks.length).toBeGreaterThan(0)
  expect(monthTicks.every(label => label.endsWith(year))).toBe(true)
})
