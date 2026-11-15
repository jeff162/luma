import { expect, test } from '@playwright/test'

// The reconciliation reports as the app actually hosts them: opened from an import's file card or a deep
// link, floating above the page, stashed to the navigation pane and restored with its data intact, and
// acting on a row. Their behavior row by row is pinned in vitest; what only the real tree shows is that the
// one app-level viewer, its lazily loaded dialog and each vendor's presentation are wired together — and,
// for PayPal, that an import really runs the matching.
//
// Runs in the `marketplace` project, after the demo data is cleared — demo mode refuses imports.

const ORDERS_CSV = [
  'order id,order url,items,to,date,total,shipping,shipping_refund,gift,tax,refund,payments',
  // Paid by a card nothing in the ledger carries, so no charge matches and the order lands in
  // "No charge found" — a row with an action to take.
  '111-0000001-0000001,,Desk Lamp; ,A,2026-02-10,24.99,0,,,1.50,,"Visa ending in 9999: 2026-02-10: $24.99; "',
].join('\n')

test('an Amazon import opens its reconciliation report, which minimizes, restores and acts on a row', async ({ page, request }) => {
  const account = await (await request.post('/api/accounts', { data: { name: 'Spec Amazon', type: 'amazon' } })).json()
  const imported = await request.post('/api/import-export/amazon/import', {
    multipart: {
      files: { name: 'spec-orders.csv', mimeType: 'text/csv', buffer: Buffer.from(ORDERS_CSV, 'utf8') },
      account_id: account.id,
      apply_categorization: 'false',
    },
  })
  expect(imported.ok()).toBeTruthy()
  const { batch_id: batchId } = await imported.json()

  try {
    // The link a finished import or sync uses: the history opens on the card, under its Amazon row.
    await page.goto(`/import-export?tab=history&batch=${batchId}`)
    await expect(page.locator('[data-focused-card="true"]')).toContainText('spec-orders.csv')
    await page.getByRole('button', { name: /1 transaction · 1 to resolve/ }).click()

    const report = page.getByText('Amazon reconciliation', { exact: true })
    await expect(report).toBeVisible()
    await expect(page.getByRole('button', { name: 'No charge found (1)' })).toBeVisible()

    await page.getByRole('button', { name: '– Minimize' }).click()
    await expect(report).toBeHidden()
    await page.getByRole('button', { name: /Amazon reconciliation — spec-orders\.csv/ }).click()
    await expect(page.getByRole('button', { name: 'No charge found (1)' })).toBeVisible()

    await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click()
    await expect(page.getByText('✓ Reviewed')).toBeVisible()
  } finally {
    await request.delete(`/api/import-export/batches/${batchId}?force=true`)
    await request.delete(`/api/accounts/${account.id}?transactions=delete`)
  }
})

// Amazon has no tab of its own: its files are recognized on the ordinary drop zone, which opens the
// import form over the page, and the import lands on its card like any other.
test('an Amazon export dropped on the importer opens its form and lands on its card', async ({ page, request }) => {
  const account = await (await request.post('/api/accounts', { data: { name: 'Spec Amazon', type: 'amazon' } })).json()
  try {
    await page.goto('/import-export')
    await page.locator('#csv-file-input').setInputFiles({
      name: 'spec-dropped-orders.csv', mimeType: 'text/csv', buffer: Buffer.from(ORDERS_CSV, 'utf8'),
    })
    await expect(page.getByText('Import Amazon orders')).toBeVisible()

    // Import waits for an account and for a decision about every card the file names.
    const importButton = page.getByRole('button', { name: 'Import 1 file' })
    await expect(importButton).toBeDisabled()
    await page.locator('select').filter({ hasText: 'Spec Amazon' }).selectOption(account.id)
    await page.getByLabel(/^Account for /).selectOption({ label: 'Untracked — not my account' })
    await importButton.click()

    await expect(page.getByText('Import Amazon orders')).toHaveCount(0)
    await expect(page.getByText('1 order imported.')).toBeVisible()
    await expect(page.locator('[data-focused-card="true"]')).toContainText('spec-dropped-orders.csv')
  } finally {
    const batches = await (await request.get('/api/import-export/batches')).json()
    for (const batch of batches.filter(b => b.filename === 'spec-dropped-orders.csv')) {
      await request.delete(`/api/import-export/batches/${batch.id}?force=true`)
    }
    await request.delete(`/api/accounts/${account.id}?transactions=delete`)
  }
})

// Two payments of one amount, days apart, with a single card charge between them: each is cornered on it,
// neither can be settled by the matcher, and the review has to show them as the one decision they are.
const CONTESTED_CSV = [
  '"Date","Time","TimeZone","Name","Type","Status","Currency","Amount","Fees","Total","Exchange Rate","Receipt ID","Balance","Transaction ID","Item Title"',
  '"2026-08-25","10:00:00","EDT","Harbor Relief Fund","Website Payment","Completed","USD","-50.00","0.00","-50.00","","","0.00","SPEC1",""',
  '"2026-08-27","10:00:00","EDT","Northgate Arts Fund","Website Payment","Completed","USD","-50.00","0.00","-50.00","","","0.00","SPEC2",""',
].join('\n')

const PAYPAL_CSV = [
  '"Date","Time","TimeZone","Name","Type","Status","Currency","Amount","Fees","Total","Exchange Rate","Receipt ID","Balance","Transaction ID","Item Title"',
  '"2026-08-25","10:00:00","EDT","Harbor Relief Fund","Website Payment","Completed","USD","-50.00","0.00","-50.00","","","0.00","SPEC1",""',
].join('\n')

test('two PayPal transactions cornered on one card charge are one row, settled beside the one that owns it', async ({ page, request }) => {
  const paypal = await (await request.post('/api/accounts', { data: { name: 'Spec PayPal', type: 'paypal' } })).json()
  const card = await (await request.post('/api/accounts', { data: { name: 'Spec Card', type: 'credit' } })).json()
  await request.post('/api/transactions', {
    data: { account_id: card.id, date: '2026-08-26', amount: 50, payee: 'PAYPAL INST XFER' },
  })
  const imported = await request.post('/api/import-export/run', {
    multipart: {
      file: { name: 'spec-contested.csv', mimeType: 'text/csv', buffer: Buffer.from(CONTESTED_CSV, 'utf8') },
      config: JSON.stringify({
        filename: 'spec-contested.csv',
        account_id: paypal.id,
        account_map: {},
        column_map: { date: 'Date', description: 'Name', amount: 'Amount', evidence_columns: ['Type'] },
        date_format: '%Y-%m-%d',
        amount_convention: 'single_signed',
        apply_categorization: false,
      }),
    },
  })
  expect(imported.ok()).toBeTruthy()
  const { batch_id: batchId } = await imported.json()

  try {
    await page.goto('/import-export?review=wallet')
    // Named for the one wallet the ledger holds.
    await expect(page.getByText(`${paypal.name} reconciliation`, { exact: true })).toBeVisible()
    // One row, not two: both rivals are on it, each with the button that gives the charge to it.
    await expect(page.getByRole('button', { name: 'Two transactions, one match (1)' })).toBeVisible()
    await expect(page.getByText('Harbor Relief Fund')).toBeVisible()
    await expect(page.getByText('Northgate Arts Fund')).toBeVisible()
    const picks = page.getByRole('button', { name: 'Pick this one' })
    await expect(picks).toHaveCount(2)
    // One answer about the group, beside the two about its rows.
    await expect(page.getByRole('button', { name: 'Neither', exact: true })).toHaveCount(1)

    // Settling one settles both: the loser has nothing left to match and leaves the review with it.
    await picks.nth(1).click()
    await expect(page.getByRole('button', { name: 'Matched (1)' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Two transactions, one match/ })).toHaveCount(0)
  } finally {
    await request.delete(`/api/import-export/batches/${batchId}?force=true`)
    await request.delete(`/api/accounts/${paypal.id}?transactions=delete`)
    await request.delete(`/api/accounts/${card.id}?transactions=delete`)
  }
})

test('a PayPal import pairs with the card charge, and the review opens from its deep link', async ({ page, request }) => {
  const paypal = await (await request.post('/api/accounts', { data: { name: 'Spec PayPal', type: 'paypal' } })).json()
  const card = await (await request.post('/api/accounts', { data: { name: 'Spec Card', type: 'credit' } })).json()
  await request.post('/api/transactions', {
    data: { account_id: card.id, date: '2026-08-23', amount: 50, payee: 'PAYPAL *HARBOR RELIEF' },
  })
  const imported = await request.post('/api/import-export/run', {
    multipart: {
      file: { name: 'spec-paypal.csv', mimeType: 'text/csv', buffer: Buffer.from(PAYPAL_CSV, 'utf8') },
      config: JSON.stringify({
        filename: 'spec-paypal.csv',
        account_id: paypal.id,
        account_map: {},
        column_map: { date: 'Date', description: 'Name', amount: 'Amount', evidence_columns: ['Type'] },
        date_format: '%Y-%m-%d',
        amount_convention: 'single_signed',
        apply_categorization: false,
      }),
    },
  })
  expect(imported.ok()).toBeTruthy()
  const { batch_id: batchId } = await imported.json()

  try {
    await page.goto('/import-export?review=wallet')
    // Named for the one wallet the ledger holds.
    await expect(page.getByText(`${paypal.name} reconciliation`, { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Matched (1)' })).toBeVisible()
    await expect(page.getByText('PAYPAL *HARBOR RELIEF')).toBeVisible()
  } finally {
    await request.delete(`/api/import-export/batches/${batchId}?force=true`)
    await request.delete(`/api/accounts/${paypal.id}?transactions=delete`)
    await request.delete(`/api/accounts/${card.id}?transactions=delete`)
  }
})
