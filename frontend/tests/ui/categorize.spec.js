import { expect, test } from '@playwright/test'

// The core daily flow: change a transaction's category via the inline CategoryPicker on the
// transactions page, and confirm it persists. We unit-test the picker in isolation but never the full
// page round-trip. Scoped to one uniquely-named transaction (the brokerage "Quarterly Dividend") so it
// can't collide with other specs' assertions on the shared demo DB, and restored at the end so the
// baseline is unchanged for parallel/repeat runs.
test('changing a transaction category via the inline picker persists', async ({ page }) => {
  await page.goto('/transactions')
  await page.getByPlaceholder('Quick filter…').fill('Quarterly Dividend')

  const categoryCell = page.locator('[title="Click to change category"]')
  await expect(categoryCell).toHaveCount(1)
  await expect(categoryCell).toContainText('Investment') // seeded category

  // Investment → Interest Income (the picker input's placeholder is the current category name).
  await categoryCell.click()
  await page.getByPlaceholder('Investment').fill('Interest Income')
  await page.locator('[data-picker-row-active]').filter({ hasText: 'Interest Income' }).click()
  await expect(page.locator('[title="Click to change category"]')).toContainText('Interest Income')

  // Restore, so the shared demo baseline is unchanged.
  await page.locator('[title="Click to change category"]').click()
  await page.getByPlaceholder('Interest Income').fill('Investment')
  await page.locator('[data-picker-row-active]').filter({ hasText: 'Investment' }).first().click()
  await expect(page.locator('[title="Click to change category"]')).toContainText('Investment')
})
