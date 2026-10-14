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
  // first time (`data-model.md` → "Signals"); the demo's seasonal gas bill is that series.
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

test('removing a row from a series updates its counts while the row stays in the report', async ({ page, request }) => {
  // The row menu's removal patches its row in place and leaves it on screen (an edited row lingers until
  // Refresh), but the counts are facts about the series: the report header, the card and the removed
  // section have to move at once rather than wait for a reload.
  const response = await request.get('/api/recurring')
  expect(response, `recurring list failed (${response.status()})`).toBeOK()
  const series = ((await response.json()).series || []).find(s => s.display_name === 'Netflix')
  expect(series, 'the demo ledger should carry a Netflix series').toBeTruthy()
  const count = series.occurrence_count

  await page.goto('/recurring')
  const card = page.locator(`[data-series-id="${series.id}"]`)
  await card.getByRole('button', { name: `${count} transactions` }).click()
  await expect(page.getByText(`${count} matching transactions`)).toBeVisible()

  try {
    await page.getByText(series.display_name, { exact: true }).last().click({ button: 'right' })
    await page.getByText('↻ Remove from recurring series').click()

    await expect(page.getByText(`${count - 1} matching transactions`)).toBeVisible()
    await expect(card.getByRole('button', { name: `${count - 1} transactions` })).toBeVisible()
    await page.getByRole('button', { name: '1 removed from this series' }).click()

    await page.getByRole('button', { name: 'Add back' }).click()
    await expect(page.getByText(`${count} matching transactions`)).toBeVisible()
    await expect(card.getByRole('button', { name: `${count} transactions` })).toBeVisible()
    await expect(page.getByRole('button', { name: /removed from this series/ })).toHaveCount(0)
  } finally {
    // Leave the series as the demo ledger had it: every removal cleared, and back to Suggested if curating
    // it is what accepted it.
    const removed = await request.get(`/api/transactions?recurring_excluded_series_id=${series.id}&limit=0`)
    for (const txn of (await removed.json()).transactions || []) {
      await request.post(`/api/recurring/${series.id}/membership`, { data: { transaction_id: txn.id, state: 'clear' } })
    }
    if (!series.confirmed) await request.post(`/api/recurring/${series.id}/unconfirm`)
  }
})

test('a link to a series switches on its section and scrolls its card into view', async ({ page, request }) => {
  // A transaction's "Part of <series>" link lands here with ?series=<id>. The saved pill selection may
  // hide the section that series sits in; the link wins over it, so the pill comes on (and is saved) and
  // the card is brought on screen rather than left for the user to find. The series is taken from the
  // last section in page order, so it sits below the others and actually needs the scroll.
  const SECTION_ORDER = ['suggested', 'confirmed', 'ended']
  const sectionOf = s => (s.status === 'ended' ? 'ended'
    : s.source === 'manual' || s.confirmed ? 'confirmed' : 'suggested')
  const response = await request.get('/api/recurring')
  expect(response, `recurring list failed (${response.status()})`).toBeOK()
  const series = ((await response.json()).series || []).filter(s => s.status !== 'suppressed')
  const target = series.reduce((best, s) => (
    SECTION_ORDER.indexOf(sectionOf(s)) >= SECTION_ORDER.indexOf(sectionOf(best)) ? s : best))
  const section = sectionOf(target)
  const others = SECTION_ORDER.filter(x => x !== section)

  const prefs = await (await request.get('/api/auth/preferences')).json()
  const saved = prefs.preferences?.['ui.recurring.filters']
  await request.post('/api/auth/preferences', { data: { key: 'ui.recurring.filters', value: others } })

  try {
    await page.goto(`/recurring?series=${target.id}`)
    const label = section[0].toUpperCase() + section.slice(1)
    await expect(page.getByRole('button', { name: new RegExp(`^${label}`), pressed: true })).toBeVisible()
    await expect(page.locator(`[data-series-id="${target.id}"]`)).toBeInViewport()

    const after = await (await request.get('/api/auth/preferences')).json()
    expect(after.preferences['ui.recurring.filters']).toEqual(expect.arrayContaining([...others, section]))
  } finally {
    await request.post('/api/auth/preferences', {
      data: { key: 'ui.recurring.filters', value: saved ?? ['suggested', 'confirmed', 'ended'] },
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
