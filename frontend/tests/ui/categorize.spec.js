import { expect, test } from '@playwright/test'

// The core daily flow: change a transaction's category via the inline CategoryPicker on the
// transactions page, and confirm it persists. We unit-test the picker in isolation but never the full
// page round-trip. Scoped to one uniquely-named transaction so it can't collide with other specs'
// assertions on the shared demo DB, and restored at the end so the baseline is unchanged for
// parallel/repeat runs.
//
// The savings "Interest Payment" rather than the brokerage "Quarterly Dividend" this used to target:
// that row is deliberately left *uncategorized* by the demo builder — it is what gives the
// uncategorized flows something to work on — so a spec that expects it to arrive with a category is
// asserting against a fixture that says the opposite. This one carries its category from the import.
test('changing a transaction category via the inline picker persists', async ({ page }) => {
  await page.goto('/transactions')
  await page.getByPlaceholder('Search…', { exact: true }).fill('Interest Payment')

  const categoryCell = page.locator('[title="Click to change category"]')
  await expect(categoryCell).toHaveCount(1)
  await expect(categoryCell).toContainText('Interest Income') // carried in from the import

  // Interest Income → Investment (the picker input's placeholder is the current category name).
  await categoryCell.click()
  await page.getByPlaceholder('Interest Income').fill('Investment')
  await page.locator('[data-picker-row-active]').filter({ hasText: 'Investment' }).first().click()
  await expect(page.locator('[title="Click to change category"]')).toContainText('Investment')

  // Restore, so the shared demo baseline is unchanged.
  await page.locator('[title="Click to change category"]').click()
  await page.getByPlaceholder('Investment').fill('Interest Income')
  await page.locator('[data-picker-row-active]').filter({ hasText: 'Interest Income' }).first().click()
  await expect(page.locator('[title="Click to change category"]')).toContainText('Interest Income')
})

// Creating a category from a row's picker once listed it twice in the page's category list (the picker's
// add and the row save each appended it), so the next search showed the same category several times.
test('a category created from the inline picker is listed once afterwards', async ({ page, request }) => {
  const name = `Picker Created ${Date.now()}`
  await page.goto('/transactions')
  await page.getByPlaceholder('Search…', { exact: true }).fill('Interest Payment')
  const categoryCell = page.locator('[title="Click to change category"]')
  await expect(categoryCell).toHaveCount(1)

  await categoryCell.click()
  await page.getByPlaceholder('Interest Income').fill(name)
  await page.keyboard.press('Enter')
  await page.getByLabel('Choose category group').selectOption({ index: 1 })
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(categoryCell).toContainText(name)

  try {
    await categoryCell.click()
    await page.getByPlaceholder(name).fill(name)
    await expect(page.locator('[data-picker-row-active]').filter({ hasText: name })).toHaveCount(1)
    await page.locator('[data-picker-row-active]').filter({ hasText: name }).first().click()
  } finally {
    // Restore the row's category and remove the created one, so the shared demo baseline is unchanged.
    await page.goto('/transactions')
    await page.getByPlaceholder('Search…', { exact: true }).fill('Interest Payment')
    await categoryCell.click()
    await page.getByPlaceholder(name).fill('Interest Income')
    await page.locator('[data-picker-row-active]').filter({ hasText: 'Interest Income' }).first().click()
    await expect(categoryCell).toContainText('Interest Income')
    const categories = await (await request.get('/api/categories')).json()
    const created = categories.find(category => category.name === name)
    if (created) {
      await request.delete(`/api/categories/${created.id}`)
      await request.delete(`/api/categories/${created.id}/forever`)
    }
  }
})
