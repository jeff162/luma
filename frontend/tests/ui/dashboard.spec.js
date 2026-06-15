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
