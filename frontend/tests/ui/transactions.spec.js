import { expect, test } from '@playwright/test'

// The demo seeds the Essential Expenses tag on Groceries/Rent (leaves) AND the Utilities *group*, and
// Discretionary on Dining/Entertainment — so transactions in those categories show the tag as an
// INHERITED chip, rendered as a button whose accessible name is "<Tag> (inherited from category|group)".
// This is the only end-to-end check of tag inheritance; every other test of it is backend-only.
test('category tags inherit onto transactions (leaf and group level)', async ({ page }) => {
  await page.goto('/transactions')
  await expect(
    page.getByRole('button', { name: 'Essential Expenses (inherited from category)' }).first(),
  ).toBeVisible()
  // "group" proves a tag on a category *group* (Utilities) reaches its leaves' transactions.
  await expect(
    page.getByRole('button', { name: 'Essential Expenses (inherited from group)' }).first(),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Discretionary (inherited from category)' }).first(),
  ).toBeVisible()
})
