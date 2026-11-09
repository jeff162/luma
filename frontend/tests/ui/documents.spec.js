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
  // say the match was inside the document. A plain document marker would leave the result looking like a bug.
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

// A document kept before its transaction arrives, then attached to it — the whole round trip, because its
// risk is in where things are mounted rather than in any one component: a picker and a confirm opened from
// inside the detail panel, a count on the page header fed by a signal from another surface, and a move that
// changes two lists at once.
//
// Leaves the ledger as it found it: the document ends deleted, and nothing else is touched.
test('a stored document is named, attached from its transaction, moved back, and deleted', async ({ page }) => {
  await page.goto('/transactions')

  // Store it. A document added on its own opens its name for editing.
  await page.getByRole('button', { name: /^Stored documents/ }).click()
  await page.locator('input[type="file"]').setInputFiles({
    name: 'documentation.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Tire rotation and balance, quoted 89.00'),
  })
  const name = page.getByLabel('Document name')
  await expect(name).toBeVisible()
  await name.fill('Tire quote.txt')
  await name.press('Enter')
  await expect(page.getByRole('button', { name: 'Tire quote.txt', exact: true })).toBeVisible()
  // The footer's Close, by its text: the panel's × is labelled Close too.
  await page.getByText('Close', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stored documents (1)' })).toBeVisible()

  // Attach it from a transaction.
  await page.getByPlaceholder('Search…', { exact: true }).fill('Lakeside Taverna')
  await page.getByText('Lakeside Taverna', { exact: true }).first().click({ button: 'right' })
  await page.getByText('✎ Edit transaction…').click()
  const attachArea = page.getByLabel('Drop or paste a document').locator('..')
  await attachArea.getByRole('button', { name: 'Stored documents (1)' }).click()
  await page.getByRole('button', { name: 'Attach Tire quote.txt' }).click()
  await expect(page.getByLabel('Move Tire quote.txt to stored documents')).toBeVisible()
  await expect(attachArea.getByRole('button', { name: /^Stored documents/ })).toHaveCount(0)

  // × is the undoable way off: straight back to the store, nothing asked.
  await page.getByLabel('Move Tire quote.txt to stored documents').click()
  await expect(page.getByLabel('Move Tire quote.txt to stored documents')).toHaveCount(0)
  await attachArea.getByRole('button', { name: 'Stored documents (1)' }).click()
  await page.getByRole('button', { name: 'Attach Tire quote.txt' }).click()

  // The bin is the permanent one, and asks first.
  await page.getByLabel('Delete Tire quote.txt').click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByLabel('Delete Tire quote.txt')).toHaveCount(0)
  await expect(attachArea.getByRole('button', { name: /^Stored documents/ })).toHaveCount(0)
})
