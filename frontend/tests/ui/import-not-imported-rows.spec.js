import { expect, test } from '@playwright/test'

// The file report's *Not imported* view, in the real tree. The unit tests cover which rows the view
// asks for and what it does with them; what only a browser can show is that the table renders at all
// where it is mounted — inside a floating panel, inside that panel's own scroll container — and that a
// real import fills it. Both rows asserted here are ones the old record could not produce: a skipped
// account left nothing but a tally, and the reason column did not exist.
//
// Runs after the mapping specs (its own project), because it seeds an account and a batch into the
// emptied tenant that those specs assume is bare. It removes both when it finishes.

const CSV = [
  'Date,Description,Amount,Account',
  '2026-04-02,Hardware store,-54.20,Checking',
  '2026-04-03,Grocery run,-31.10,Checking',
  'not-a-date,Annual fee,-35.00,Checking',
  '2026-04-04,Interest,1.12,Savings',
].join('\n')

test('a file report lists the rows the import left out, with the reason for each', async ({ page, request }) => {
  const checking = await (await request.post('/api/accounts', {
    data: { name: 'Spec Watchline Checking', type: 'depository' },
  })).json()
  const imported = await request.post('/api/import-export/run', {
    multipart: {
      file: { name: 'spec-left-behind.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV, 'utf8') },
      config: JSON.stringify({
        filename: 'spec-left-behind.csv',
        account_map: { Checking: checking.id },
        skip_accounts: ['Savings'],
        column_map: { date: 'Date', description: 'Description', amount: 'Amount', account: 'Account' },
        date_format: '%Y-%m-%d',
        amount_convention: 'single_signed',
        apply_categorization: false,
      }),
    },
  })
  expect(imported.ok()).toBeTruthy()
  const result = await imported.json()
  expect(result.imported).toBe(2)
  const batchId = result.batch_id

  try {
    await page.goto(`/import-export?openBatch=${batchId}`)
    await expect(page.getByText('spec-left-behind.csv')).toBeVisible()

    // Two rows did not come in, and the control says so before it is opened.
    const notImported = page.getByRole('button', { name: /Not imported/ })
    await expect(notImported).toBeVisible()
    await notImported.click()

    await expect(page.getByText("Invalid date: 'not-a-date'")).toBeVisible()
    await expect(page.getByText("Skipped account 'Savings'")).toBeVisible()
    // The row as the file wrote it, which is the whole point of keeping it: the date cell that failed
    // is shown rather than blanked.
    await expect(page.getByText('Annual fee')).toBeVisible()

    // One reason at a time.
    await page.getByRole('button', { name: /Skipped account \(1\)/ }).click()
    await expect(page.getByText("Skipped account 'Savings'")).toBeVisible()
    await expect(page.getByText("Invalid date: 'not-a-date'")).toHaveCount(0)
  } finally {
    await request.delete(`/api/import-export/batches/${batchId}?force=true`)
    await request.delete(`/api/accounts/${checking.id}?transactions=delete`)
  }
})
