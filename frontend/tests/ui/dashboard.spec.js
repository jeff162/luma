import { expect, test } from '@playwright/test'

// With the demo's ~3 months of data the dashboard should render its charts and switch chart modes
// without crashing — empty-state can hide render bugs that only surface once there's real data.
//
// Navigate via the Dashboard nav link rather than goto('/'): the app's once-per-mount startup-route
// preference can redirect "/" elsewhere, and that preference is shared across parallel specs on the
// one demo DB. Clicking the link lands on the dashboard regardless.
test('dashboard renders and switches chart modes with demo data', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Expenses' })).toBeVisible()

  // Exercise the chart-mode controls against real data; the page must stay rendered.
  await page.getByRole('button', { name: 'Trends' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await page.getByRole('button', { name: 'Income' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
})

// The Trends tab's monthly-averages table drills like the rest of the page: a group row opens that
// group's categories, and a category's ↗ opens the transactions behind its figure, in a report scoped to
// the category and the table's window.
test('trends averages drill from a group to its categories and open a category report', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await page.getByRole('button', { name: 'Trends' }).click()
  // The frame is a saved preference on the shared demo database, which the spec above leaves on Income.
  await page.getByRole('button', { name: 'Expenses' }).click()

  const groupRow = page.getByRole('button', { name: /^Show the categories in / }).first()
  await expect(groupRow).toBeVisible()
  const groupName = (await groupRow.getAttribute('aria-label')).replace('Show the categories in ', '')

  // The group picker offers what the table lists at "All groups" — the groups with transactions in the
  // window on screen — alphabetically. It once listed the groups with spending in the current month.
  const tableGroups = (await page.getByRole('button', { name: /^Show the categories in / }).evaluateAll(
    rows => rows.map(row => row.getAttribute('aria-label').replace('Show the categories in ', '')),
  ))
  const groupPicker = page.locator('select').filter({ has: page.locator('option', { hasText: 'All groups' }) })
  await expect.poll(async () => (await groupPicker.locator('option').allTextContents()).slice(1))
    .toEqual([...tableGroups].sort((a, b) => a.localeCompare(b)))

  // The drill reloads every chart on the tab. The table is clicked at the bottom of a long page, so the
  // reader has to stay there while that happens — swapping the tab out for a loading state collapses the
  // page and lands them back at the top. The scroll may still move by exactly as much as a shorter page
  // forces (fewer categories than groups, read from the bottom), and no further; the viewport position
  // of the table cannot express that, since that clamp moves it too.
  const averagesTitle = page.getByText(/^Monthly averages/).first()
  const scrollState = () => averagesTitle.evaluate(el => {
    let node = el.parentElement
    while (node && !/(auto|scroll)/.test(getComputedStyle(node).overflowY)) node = node.parentElement
    const scroller = node || document.scrollingElement
    return { top: scroller.scrollTop, max: scroller.scrollHeight - scroller.clientHeight }
  })
  await page.getByRole('button', { name: /^Show the categories in / }).last().scrollIntoViewIfNeeded()
  const scrollBefore = await scrollState()
  expect(scrollBefore.top).toBeGreaterThan(0)
  await groupRow.click()

  // Drilled: the table names the group and offers the way back, and its rows are categories.
  const back = page.getByRole('button', { name: 'All groups', exact: true })
  await expect(back).toBeVisible()
  await expect(page.getByText(`Monthly averages · ${groupName}`)).toBeVisible()
  const reportArrow = page.getByRole('button', { name: /^Open the transactions behind / }).first()
  await expect(reportArrow).toBeVisible()
  const scrollAfter = await scrollState()
  expect(Math.abs(scrollAfter.top - Math.min(scrollBefore.top, scrollAfter.max))).toBeLessThan(2)

  // A group's charts run at a smaller scale than the whole ledger's, which is where a value axis that
  // rounds to whole thousands repeats itself ("$0k, $1k, $1k, $2k"). Every Trends axis has to tell its
  // own ticks apart.
  const repeatedTicks = await page.evaluate(() => [...document.querySelectorAll('.recharts-yAxis')]
    .map(axis => [...axis.querySelectorAll('.recharts-cartesian-axis-tick text')].map(tick => tick.textContent))
    .filter(labels => new Set(labels).size !== labels.length))
  expect(repeatedTicks).toEqual([])
  const categoryName = (await reportArrow.getAttribute('aria-label')).replace('Open the transactions behind ', '')
  await reportArrow.click()
  const reportTitle = page.getByText(new RegExp(`^${categoryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · (Last 12 months|\\d{4}) · Spending$`))
  await expect(reportTitle).toBeVisible()

  // The report sits over the table, so close it before stepping back up to the groups.
  await page.keyboard.press('Escape')
  await expect(reportTitle).toBeHidden()
  await back.click()
  await expect(page.getByRole('button', { name: /^Show the categories in / }).first()).toBeVisible()
})
