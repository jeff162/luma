import { expect, test } from '@playwright/test'

// globalSetup loads the demo dataset into the isolated stack, and the loader also seeds UI preferences
// so the demo opens expanded (the accounts list collapses by default). All four demo account names
// should therefore render up front — proving both that the data loaded and that the expansion
// preference took effect (collapsed, these names would be hidden).
test('demo data is loaded and visible in the app', async ({ page }) => {
  await page.goto('/accounts')
  await expect(page.getByText('Everyday Checking')).toBeVisible()
  await expect(page.getByText('Rainy Day Savings')).toBeVisible()
  await expect(page.getByText('Rewards Card')).toBeVisible()
  await expect(page.getByText('Brokerage')).toBeVisible()
})
