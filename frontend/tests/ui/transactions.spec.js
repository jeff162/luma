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
