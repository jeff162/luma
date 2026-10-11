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

// Right-clicking a row while its merchant hover card is up used to leave the card on top of the context
// menu: the pointer never moves when a menu opens under it, so no `mouseleave` fired, and the shared
// Tooltip sits at the highest z-index in the app (it has to clear the dialog stack). The merchant card
// is also `interactive`, so it kept pointer events and swallowed clicks meant for the menu items it
// covered — the menu was not merely obscured but partly unusable. The fix is in the Tooltip primitive
// (a `contextmenu` dismissal beside the existing scroll one), so this guards every row hover, not just
// this cell.
//
// Read-only: the menu's first item opens the editor panel and nothing is saved.
test('right-clicking a row dismisses the merchant hover instead of covering the menu', async ({ page }) => {
  await page.goto('/transactions')
  await page.getByPlaceholder('Search…', { exact: true }).fill('Lakeside Taverna')

  // Every demo transaction is imported from a file, so the merchant hover always has origin detail to
  // show and is attached (see hasFileOriginDetail).
  const merchant = page.getByText('Lakeside Taverna', { exact: true }).first()
  await merchant.hover()
  const hoverCard = page.locator('[role="tooltip"]')
  await expect(hoverCard).toBeVisible() // after the row-hover dwell

  await merchant.click({ button: 'right' })
  await expect(hoverCard).toHaveCount(0)

  // The click is the half of the assertion the visibility check can't make: Playwright's hit-target
  // check fails the click if anything covers the item, which is exactly what the card was doing.
  const editItem = page.getByText('✎ Edit transaction…')
  await expect(editItem).toBeVisible()
  await editItem.click()
  await expect(editItem).toHaveCount(0) // the menu closed because the click reached it
})

// The Export dialog opens on a copy of the page's filter. Two things only a browser shows: the filter
// popover opens whole inside a dialog, and changing the copy leaves the page's own chips and list alone.
test('the export dialog works on a copy of the page filter', async ({ page }) => {
  const feed = await (await page.request.get('/api/transactions?limit=1')).json()
  const first = feed.transactions[0]
  const fragment = (first.display_name || first.merchant_name || first.raw_name).slice(0, 4).trim()
  const chipText = `Payee contains “${fragment}”`

  await page.goto('/transactions')
  const countLabel = page.locator('text=/^\\d+ transactions?$/')
  await expect(countLabel).not.toHaveText('0 transactions')
  const unfilteredCount = await countLabel.textContent()
  await page.getByRole('button', { name: /Filters?/ }).first().click()
  await page.getByRole('button', { name: 'Payee' }).click()
  await page.getByLabel('Search payee name').fill(fragment)
  await page.getByText(chipText).click()
  await page.keyboard.press('Escape')
  const pageChip = page.locator('span[title*="click to exclude"]').filter({ hasText: chipText })
  await expect(pageChip).toHaveCount(1)
  await expect(countLabel).not.toHaveText(unfilteredCount)
  const filteredCount = await countLabel.textContent()

  await page.getByRole('button', { name: 'Export…' }).click()
  const dialog = page.locator('[data-modal-overlay]')
  await expect(dialog.getByText(chipText)).toBeVisible()

  const download = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Export', exact: true }).click()
  expect((await download).suggestedFilename()).toMatch(/\.csv$/)
  await expect(dialog).toHaveCount(0)

  await page.getByRole('button', { name: 'Export…' }).click()
  await dialog.getByRole('button', { name: 'Clear all' }).click()
  await expect(dialog.getByText(chipText)).toHaveCount(0)
  // The category tree is the popover's tallest tab, and taller than the dialog's body. A popover placed
  // inside that body is cut off at its edge; the tab row's parent is the popover itself.
  await dialog.getByRole('button', { name: /Filters?/ }).click()
  await dialog.getByRole('button', { name: 'Categories' }).click()
  await expect(dialog.getByRole('button', { name: 'Categories' }).locator('xpath=../..')).toBeInViewport({ ratio: 1 })
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  await expect(pageChip).toHaveCount(1)
  await expect(countLabel).toHaveText(filteredCount)
})
