import { expect, test } from '@playwright/test'

// Clicking a row's R marker marks it reviewed, and the list does not change under the click — even with
// the ledger filtered to Needs review, where the reviewed row no longer matches. That is what keeps
// clicking down a list safe, and it only holds in the real page: the unit tests pin the row patch, not
// the ledger that decides whether to re-query. Refresh is the one thing that drops the row.
//
// The demo data is shared across the phase, so the test ends by undoing its own review.

test('marking a row reviewed from its marker leaves the filtered list as it was, and undo restores it', async ({ page }) => {
  await page.goto('/transactions?only=needs-review')
  await expect(page.getByRole('button', { name: '✕ Needs review' })).toBeVisible()

  const countLabel = page.locator('text=/^\\d+ transactions?$/')
  await expect(countLabel).toBeVisible()
  await expect(countLabel).not.toHaveText('0 transactions')
  const countText = await countLabel.textContent()

  const markers = page.getByRole('button', { name: 'Needs review — mark reviewed' })
  await expect(markers.first()).toBeVisible()
  const before = await markers.count()

  await markers.first().click()
  await expect(page.getByText('Marked reviewed')).toBeVisible()

  // The row's marker is gone, but the row and the count stay put — no re-query happened.
  await expect(markers).toHaveCount(before - 1)
  await expect(countLabel).toHaveText(countText)

  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(markers).toHaveCount(before)
  await expect(countLabel).toHaveText(countText)
})
