import { expect, test } from '@playwright/test'

// The Payee tab offers what was typed as a filter of its own, ahead of the names that contain it. What
// only a browser shows is the chain behind that row: the names come from their own endpoint, the pick
// becomes a chip, and the chip reaches the ledger query as a fragment rather than as a name.

test('a fragment of a payee name filters the ledger', async ({ page }) => {
  // Taken from the ledger rather than written down, so the spec does not depend on what the demo data
  // happens to call anything.
  const feed = await (await page.request.get('/api/transactions?limit=1')).json()
  const first = feed.transactions[0]
  const name = first.display_name || first.merchant_name || first.raw_name
  const fragment = name.slice(0, 4).trim()

  await page.goto('/transactions')
  const countLabel = page.locator('text=/^\\d+ transactions?$/')
  await expect(countLabel).not.toHaveText('0 transactions')
  const unfiltered = Number((await countLabel.textContent()).split(' ')[0])

  await page.getByRole('button', { name: /Filters?/ }).first().click()
  await page.getByRole('button', { name: 'Payee' }).click()
  await page.getByLabel('Search payee name').fill(fragment)

  // The name the fragment came from is offered, so the list is answering for this fragment.
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible()
  await page.getByText(`Payee contains “${fragment}”`).click()
  await page.keyboard.press('Escape')

  await expect(page.locator('span[title*="click to exclude"]').filter({ hasText: `Payee contains “${fragment}”` })).toBeVisible()
  await expect(countLabel).not.toHaveText(`${unfiltered} transactions`)
  const filtered = Number((await countLabel.textContent()).split(' ')[0])
  expect(filtered).toBeGreaterThan(0)
  expect(filtered).toBeLessThan(unfiltered)
})
