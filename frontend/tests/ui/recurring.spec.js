import { expect, test } from '@playwright/test'

// The Recurring page's three views, and the findings the demo dataset was shaped to produce.
//
// The dataset carries a stopped subscription, a streaming price step and a water bill that outgrew the
// rule filing it, precisely so this page can be seen with work on it rather than empty. Backend tests
// assert the signals compute; this asserts the page *presents* them — the review tab appears with the
// kinds it found, each finding offers the action that settles it, and switching views does not blank
// the page.
//
// Read-only: no signal is dismissed and no series is confirmed, ended or deleted, so the shared demo
// ledger is unchanged for the specs running beside this one.

// Series have to exist before signals can be computed over them, and detection is a catch-up the app
// runs itself on load (App.jsx calls this endpoint on mount). Called explicitly here so the page is not
// racing that background request: it is watermarked, so this is the same no-op a second app load would
// make rather than an extra scan.
test.beforeEach(async ({ request }) => {
  const response = await request.post('/api/recurring/auto-scan')
  expect(response, `recurring auto-scan failed (${response.status()})`).toBeOK()
})

test('detected series are listed and the views switch without losing the page', async ({ page }) => {
  await page.goto('/recurring')
  await expect(page.getByRole('heading', { name: 'Recurring Transactions' })).toBeVisible()

  // A monthly card charge with six occurrences — detection's bread and butter.
  await expect(page.getByText('Netflix').first()).toBeVisible()

  await page.getByRole('button', { name: /Upcoming/ }).first().click()
  await expect(page.getByRole('heading', { name: 'Recurring Transactions' })).toBeVisible()

  await page.getByRole('button', { name: /Series/ }).first().click()
  await expect(page.getByText('Netflix').first()).toBeVisible()
})

test('the review view reports the anomalies the demo data was built to raise', async ({ page }) => {
  await page.goto('/recurring')
  await page.getByRole('button', { name: /Needs attention/ }).first().click()

  // The kind tabs are rendered only for kinds with something open, so their presence is the assertion:
  // a subscription that stopped, and a price that stepped up on the newest charge.
  await expect(page.getByRole('button', { name: /Missing charge/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Amount changed/ })).toBeVisible()

  // Every finding offers the way to settle it. Dismiss is the one action every kind carries, so its
  // presence is what proves rows rendered rather than an empty state under a populated tab.
  await expect(page.getByRole('button', { name: 'Dismiss' }).first()).toBeVisible()

  // A rule-range finding carries the action that fixes the cause rather than the symptom: the demo's
  // newest water bill grew past the ceiling on the rule that files these, so it arrived uncategorized
  // and nothing else in the app noticed. Selecting the kind also covers the tabs actually filtering.
  await page.getByRole('button', { name: /Outside a rule/ }).first().click()
  await expect(page.getByRole('button', { name: 'Widen to include' }).first()).toBeVisible()
})

test('a transfer between two accounts is one series, not two', async ({ page }) => {
  // The demo's standing transfer is recorded twice — once leaving checking, once arriving in savings —
  // which is what any movement between two tracked accounts looks like to a ledger organized by
  // account. The detector pairs those rows by the money (same amount, opposite directions, days apart)
  // and reads the rhythm off the pairs, so one series owns both legs. The demo's two sides are worded
  // differently on purpose, which is what makes this the end-to-end proof: no name is involved.
  await page.goto('/recurring')
  await page.getByPlaceholder(/Search merchant/).fill('Transfer')

  const card = page.locator('[data-series-id]')
  await expect(card).toHaveCount(1)
  await expect(card.getByText('Everyday Checking')).toBeVisible()
  await expect(card.getByText('Rainy Day Savings')).toBeVisible()

  // One set of actions, over a count that spans both legs' rows.
  await expect(card.getByRole('button', { name: 'Not recurring' })).toHaveCount(1)
  await expect(card.getByRole('button', { name: /12 transactions/ })).toBeVisible()
})
