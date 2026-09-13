import { expect, test } from '@playwright/test'

// Splitting one charge across categories, end to end.
//
// The demo's "Warehouse Club" run is the case the feature exists for: one receipt that was partly food
// and partly household goods, where filing the whole thing under either is wrong. Backend tests cover
// the invariants (the parts sum to the transaction, every part has a category); what only a browser can
// show is that the ledger *says so* — the row advertises itself as divided, and the marker is the way
// into the editor holding the real allocations.
//
// Read-only: the editor is opened and closed without saving, so the shared demo ledger is unchanged for
// the specs running beside this one.
test('a split transaction is marked in the ledger and opens on its parts', async ({ page }) => {
  await page.goto('/transactions')
  await page.getByLabel('Search transactions', { exact: true }).fill('Warehouse Club')

  // The category cell carries the part count rather than a category, because no single category is the
  // truth about this row.
  const splitChip = page.getByText('Split (2)')
  await expect(splitChip).toBeVisible()
  await splitChip.click()

  await expect(page.getByText('Split across categories')).toBeVisible()

  // The labels are what make a split readable months later, and they are stored per part rather than
  // derived, so they are the honest check that these are the seeded allocations and not a fresh editor
  // opened on two blank rows.
  const descriptions = page.getByRole('textbox', { name: 'Description' })
  await expect(descriptions).toHaveCount(2)
  await expect(descriptions.nth(0)).toHaveValue('Food shop')
  await expect(descriptions.nth(1)).toHaveValue('Detergent, paper goods')

  // Matched loosely: the amounts are rendered from stored floats, so trailing-zero formatting is not
  // something this spec should be asserting about.
  const amounts = page.getByRole('textbox', { name: 'Amount' })
  await expect(amounts.nth(0)).toHaveValue(/^148\.20?$/)
  await expect(amounts.nth(1)).toHaveValue(/^66\.40?$/)
})
