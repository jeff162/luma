import { expect, test } from '@playwright/test'

const SAMPLE_CSV = `Date,Description,Amount,Account,Notes
2026-01-03,Coffee Shop,-4.75,Checking,Morning run
2026-01-04,Paycheck,1200.00,Checking,Payroll
`

function sampleCsvFile() {
  return {
    name: 'sample-transactions.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(SAMPLE_CSV, 'utf8'),
  }
}

async function expectSharedMappingSuggestions(scope) {
  await expect(scope.getByText('Accept Date')).toBeVisible()
  await expect(scope.getByText('Accept Description')).toBeVisible()
  await expect(scope.getByText('Accept Amount')).toBeVisible()
  await expect(scope.getByText('Accept Account')).toBeVisible()
}

test('shared mapping suggestions stay aligned between import flow and data source editor', async ({ page }) => {
  await page.goto('/import-export')

  await page.getByRole('button', { name: 'Skip' }).click()
  await page.locator('#csv-file-input').setInputFiles(sampleCsvFile())

  await expectSharedMappingSuggestions(page)
  await expect(page.getByText('temporary draft')).toBeVisible()

  await page.goto('/import-export')
  await page.getByRole('button', { name: 'Manage sources' }).click()
  await expect(page.getByText('Manage data sources')).toBeVisible()
  const managerPanel = page.locator('div').filter({
    has: page.getByText('Manage data sources'),
    has: page.getByRole('button', { name: 'Close' }),
  }).first()

  const createFirst = managerPanel.getByRole('button', { name: '+ Create first data source' })
  if (await createFirst.isVisible()) {
    await createFirst.click()
  } else {
    const newSourceButton = managerPanel.locator('div').filter({ hasText: /^\+ New data source$/ })
    await expect(newSourceButton).toBeVisible()
    await newSourceButton.dispatchEvent('click')
  }

  await page.locator('input[type="file"][accept=".csv,text/csv"]').last().setInputFiles(sampleCsvFile())

  await expectSharedMappingSuggestions(page)
  await expect(page.getByText('Using sample-transactions.csv as the template.')).toBeVisible()
})
