import { expect, test } from '@playwright/test'

// Paperwork attached to transactions, and the thing attaching it is *for*: finding the transaction
// again by something written inside the document rather than anywhere on the row.
//
// The demo attaches one document of each kind the store can read text from — a PDF with a real text
// layer, an emailed receipt as markup, and a plain-text confirmation. Backend tests assert each one
// extracted *something*; what only a browser shows is the whole chain standing up at once: extraction,
// the FTS index, the `doc:` filter, and the ledger explaining why a row it returned is on screen when
// no visible field contains the search term.
//
// Read-only: filtering and opening a viewer change nothing in the ledger.

// One row, matched on words that appear in no field of it — only inside the attachment.
async function expectOnlyMatch(page, query, merchant) {
  await page.getByLabel('Search transactions', { exact: true }).fill(query)
  await expect(page.getByText(merchant).first()).toBeVisible()
  await expect(page.getByRole('button', { name: /attached document/ })).toHaveCount(1)
}

test('a transaction is findable by the text inside its attached receipt', async ({ page }) => {
  await page.goto('/transactions')

  // Tier 1: a PDF's own text layer. Two tokens, so this also covers the filter ANDing them rather than
  // matching either.
  await expectOnlyMatch(page, 'doc:rabies booster', 'City Vet Clinic')

  // The row's only explanation for being here: every field on it lacks both words, so the marker has to
  // say the match was inside the document. A plain paperclip would leave the result looking like a bug.
  const marker = page.getByRole('button', { name: 'Matched inside an attached document — open it' })
  await expect(marker).toBeVisible()

  await marker.click()
  await expect(page.getByText('vet-invoice.pdf').first()).toBeVisible()
})

test('every kind of readable attachment reaches the same search', async ({ page }) => {
  await page.goto('/transactions')

  // Tier 2: markup reduced to words. "Garage" is in the emailed receipt's table, nowhere on the row.
  await expectOnlyMatch(page, 'doc:garage', 'Sky Harbor Parking')

  // Tier 3: a paste that was already text.
  await expectOnlyMatch(page, 'doc:transferable', 'Riverstone Amphitheater')
})
