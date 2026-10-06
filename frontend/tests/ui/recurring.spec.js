import { expect, test } from '@playwright/test'

// The Recurring page's three views, and the findings the demo dataset was shaped to produce.
//
// The dataset carries a stopped subscription, a streaming price step and a water bill that outgrew the
// rule filing it, precisely so this page can be seen with work on it rather than empty. Backend tests
// assert the signals compute; this asserts the page *presents* them — the review tab appears with the
// kinds it found, each finding offers the action that settles it, and switching views does not blank
// the page.
//
// Read-only apart from one exclusion, which the test undoes itself and clears again in a `finally`: no
// signal is dismissed and no series is confirmed, ended or deleted, so the shared demo ledger is unchanged
// for the specs running beside this one.

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

  // Selecting a kind covers the tabs actually filtering, not merely rendering.
  await page.getByRole('button', { name: /Amount changed/ }).click()
  await expect(page.getByRole('button', { name: /^All/ })).toBeVisible()

  // The drifted water bill the demo also seeds is *not* here: it is a finding about a rule, and it
  // belongs to the Rules page's checkup (tests/ui/rule-checkup.spec.js).
  await expect(page.getByRole('button', { name: /Outside a rule/ })).toHaveCount(0)
})

test('an amount finding can exclude its charge from the series, and Undo puts it back', async ({ page, request }) => {
  // The unit test pins that the button hands back its finding; what only the page can show is the wiring
  // behind it — the exclusion lands, the finding about *that charge* goes, and the prompt's Undo brings
  // both back.
  //
  // Asserted about the one finding, by the key the server identifies it with, rather than about how many
  // findings are left — which does not have to fall. On a series whose price is still climbing, dropping
  // the newest charge makes the charge before it the newest, and *its* step is then reported for the
  // first time (`data-model.md` → "Exclude from series"); the demo's seasonal gas bill is that series.
  // Clicking whichever row rendered first therefore tested one of two different behaviors depending on
  // how the two same-day findings happened to sort, and the cleanup below cleared the other one's charge.
  const response = await request.get('/api/recurring/signals')
  expect(response, `recurring signals failed (${response.status()})`).toBeOK()
  const finding = ((await response.json()).signals || []).find(s => s.kind === 'price_change')
  expect(finding, 'the demo ledger should carry a price step to exclude').toBeTruthy()

  await page.goto('/recurring')
  await page.getByRole('button', { name: /Needs attention/ }).first().click()
  await page.getByRole('button', { name: /Amount changed/ }).click()
  const findingRow = page.locator(`[data-signal-key="${finding.key}"]`)
  await expect(findingRow).toHaveCount(1)

  try {
    await findingRow.getByRole('button', { name: 'Exclude from series' }).click()
    await expect(page.getByText('Excluded from series')).toBeVisible()
    await expect(findingRow).toHaveCount(0)

    await page.getByRole('button', { name: /Undo/ }).click()
    await expect(findingRow).toHaveCount(1)
  } finally {
    // Whatever happened above, leave the charge in its series for the specs that read the demo ledger.
    await request.post(`/api/recurring/${finding.series_id}/membership`, {
      data: { transaction_id: finding.txn_id, state: 'clear' },
    })
  }
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
