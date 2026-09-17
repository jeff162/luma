import { expect, test } from '@playwright/test'

// Clicking a row's R marker marks it reviewed, and the list does not change under the click — even with
// the ledger filtered to Needs review, where the reviewed row no longer matches. That is what keeps
// clicking down a list safe, and it only holds in the real page: the unit tests pin the row patch, not
// the ledger that decides whether to re-query. Refresh is the one thing that drops the row.
//
// The demo data is shared across the phase, so the test ends by undoing its own review.
//
// **The marker count is instrumented** (see `docs/transient-failures.md` → the intermittent one here):
// it has once come back unchanged, with the clicked row still marked and the confirmation toast shown,
// which leaves two candidates — the write never landed, or the row patch was overwritten by a list
// response already in flight. The two are told apart by the transaction's state on the server and by
// whether the page asked for the list again, so a failure reports both rather than only the count.

test('marking a row reviewed from its marker leaves the filtered list as it was, and undo restores it', async ({ page, request }) => {
  // Every transaction request this page makes, in order, so a failure can say whether the list was
  // re-queried after the write — and with what.
  const calls = []
  page.on('response', response => {
    const url = new URL(response.url())
    if (!url.pathname.startsWith('/api/transactions')) return
    calls.push(`${response.request().method()} ${url.pathname}${url.search} → ${response.status()}`)
  })

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
  const sinceClick = calls.length
  // Which row was clicked, taken from the confirmation the app itself wrote (“<payee>” no longer needs
  // review), so its state can be read back from the server if the count disagrees.
  const clickedPayee = (await page.getByText(/no longer needs review/).textContent() || '')
    .replace(/^[^\u201c]*\u201c/, '').replace(/\u201d.*$/, '')

  // The row's marker is gone, but the row and the count stay put — no re-query happened.
  try {
    await expect(markers).toHaveCount(before - 1)
  } catch (err) {
    throw new Error([
      err.message,
      '',
      `Clicked row: ${clickedPayee}`,
      // needs_review = 0 means the write landed and the page lost it; 1 means it never landed.
      `Server state after the click: ${await serverState(request, clickedPayee)}`,
      `Transaction requests before the click: ${calls.slice(0, sinceClick).join(' | ') || 'none'}`,
      `…and after it: ${calls.slice(sinceClick).join(' | ') || 'none'}`,
    ].join('\n'))
  }
  await expect(countLabel).toHaveText(countText)

  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(markers).toHaveCount(before)
  await expect(countLabel).toHaveText(countText)
})

// What the ledger holds for the clicked row, read straight from the API so it cannot be the page's own
// stale copy. Failure to read is reported rather than thrown — this runs while a test is already
// failing, and losing the original assertion to a second error would be the worse outcome.
async function serverState(request, payee) {
  try {
    const response = await request.get(
      `/api/transactions?quick_filter=${encodeURIComponent(payee || '')}&limit=5`)
    const body = await response.json()
    return JSON.stringify((body.transactions || []).map(txn => ({
      id: txn.id, payee: txn.merchant_name || txn.display_name, needs_review: txn.needs_review,
    })))
  } catch (err) {
    return `could not be read (${err.message})`
  }
}
