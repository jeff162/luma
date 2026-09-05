import { expect, test } from '@playwright/test'

// `Check overlaps` on the Rules page: rules that could both claim the same transaction.
//
// The check distinguishes two situations and treats them differently, which is the whole point of it.
// Two amount ranges that meet are a *problem* — nothing decides which rule wins, so those cannot even be
// dismissed. Two merchant matchers where one nests inside the other are *information* — the narrower one
// wins, and saying so is the service. The demo seeds one pair of each deliberately, because the checker
// has nothing to report on a tidy rule set and would otherwise only ever be seen empty.
//
// Read-only: nothing is dismissed and no rule is deleted or edited, so the shared demo rule set is
// unchanged.
test('the overlap check separates ambiguous rules from merely nested ones', async ({ page }) => {
  await page.goto('/rules')
  await page.getByRole('button', { name: 'Check overlaps' }).click()

  await expect(page.getByText('Overlapping rules')).toBeVisible()

  // The two sections render only when their kind found something, so both being present is the
  // assertion that the checker told the seeded pairs apart rather than lumping them together.
  await expect(page.getByText('Amount ranges that overlap')).toBeVisible()
  await expect(page.getByText('Merchant matchers that nest')).toBeVisible()

  // The header counts the open set from the server's own tally. Its two halves are counted separately
  // because only the first half is work: the second is there to be read.
  await expect(page.getByText(/\d+ to settle, \d+ for information\./)).toBeVisible()
})
