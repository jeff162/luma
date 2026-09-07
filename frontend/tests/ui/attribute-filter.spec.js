import { expect, test } from '@playwright/test'

// The attribute filter reaches the user through two controls that share one vocabulary, and both of the
// things worth checking here are invisible to unit tests: that each control is wired to the real
// endpoint (the list is fetched, not hardcoded), and that the ledger actually re-queries when the
// filter changes. The unit tests already pin the button's own state machine.
//
// Locators are scoped by role rather than by text throughout, because several attribute names
// ("Recurring", "Split") also name a nav destination or a row affordance elsewhere on the page.

test('the ledger quick filter narrows to one kind of transaction and back', async ({ page }) => {
  await page.goto('/transactions')

  // The count renders as "0 transactions" until the first page lands, so wait for the real figure
  // rather than capturing a baseline from the loading state.
  const countLabel = page.locator('text=/^\\d+ transactions?$/')
  await expect(countLabel).toBeVisible()
  await expect(countLabel).not.toHaveText('0 transactions')
  const unfilteredText = await countLabel.textContent()
  const unfiltered = Number(unfilteredText.split(' ')[0])

  // The page seeds a choice (Uncategorized, switched off), so reaching a different one goes through
  // the caret rather than the body — the body would toggle the seeded choice on instead.
  await page.getByRole('button', { name: 'Choose what to filter on' }).click()
  await page.getByRole('menuitemradio', { name: 'Recurring' }).click()

  // The pick applied on its own — no separate Apply — and the ledger re-queried. Waited for rather
  // than read immediately: the count comes from the response, not from the click.
  await expect(countLabel).not.toHaveText(unfilteredText)
  const filtered = Number((await countLabel.textContent()).split(' ')[0])
  expect(filtered).toBeGreaterThan(0)
  expect(filtered).toBeLessThan(unfiltered)

  // Toggling off restores the full ledger while *keeping* the choice — the property that makes this one
  // button a replacement for the two it succeeded rather than a narrowing of them.
  await page.getByRole('button', { name: '✕ Recurring' }).click()
  await expect(countLabel).toHaveText(unfilteredText)
  await expect(page.getByRole('button', { name: 'Recurring', exact: true })).toBeVisible()
})

test('a ?only= link arrives already filtered', async ({ page }) => {
  // What the Tasks nudge relies on: the link both picks the attribute and applies it, outranking both
  // the seeded default and whatever the session remembered.
  await page.goto('/transactions?only=needs-review')
  await expect(page.getByRole('button', { name: '✕ Needs review' })).toBeVisible()
})

test('the ledger opens on a seeded choice that is switched off', async ({ page }) => {
  // No "clear" and no empty state: the button always has something to name itself after, and starts
  // showing everything.
  await page.goto('/transactions')
  await expect(page.getByRole('button', { name: 'Uncategorized', exact: true })).toBeVisible()
})

test('the same attributes are combinable from the FilterBar', async ({ page }) => {
  await page.goto('/transactions')
  await page.getByRole('button', { name: /Filters?/ }).first().click()
  await page.getByRole('button', { name: 'Attributes' }).click()

  // Served from the same endpoint as the ledger's quick filter, so a mismatch here means the two
  // surfaces have drifted apart.
  const row = page.getByText('Has attachment')
  await expect(row).toBeVisible()
  await row.click()
  await page.keyboard.press('Escape')

  // Unlike the quick filter this one becomes a chip, which is what lets it combine with other facets.
  await expect(page.locator('span[title*="click to exclude"]').filter({ hasText: 'Has attachment' })).toBeVisible()
})
