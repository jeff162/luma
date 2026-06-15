import { expect, test } from '@playwright/test'

const SAMPLE_CSV = `Date,Description,Amount,Account,Notes
2026-01-03,Coffee Shop,-4.75,Checking,Morning run
2026-01-04,Paycheck,1200.00,Checking,Payroll
`

const MISMATCHED_CSV = `Date,Description,Amount (in $),Account Name,Category
2026-02-03,Coffee Shop,-4.75,Checking,Coffee
2026-02-04,Paycheck,1200.00,Checking,Income
`

const NEW_ACCOUNT_CSV = `Date,Description,Amount,Account,Notes
2026-03-03,Coffee Shop,-4.75,Alias Wallet (...7777),Morning run
2026-03-04,Paycheck,1200.00,Alias Wallet (...7777),Payroll
`

function sampleCsvFile() {
  return {
    name: 'sample-transactions.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(SAMPLE_CSV, 'utf8'),
  }
}

function mismatchedCsvFile() {
  return {
    name: 'mismatched-transactions.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(MISMATCHED_CSV, 'utf8'),
  }
}

function newAccountCsvFile() {
  return {
    name: 'new-account-transactions.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(NEW_ACCOUNT_CSV, 'utf8'),
  }
}

function uniqueDataSourceName(prefix) {
  return `${prefix} ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`
}

async function createImportProfile(request, {
  name,
  headerFingerprint = 'Date,Description,Amount,Account,Notes',
  columnMap = {
    date: 'Date',
    amount: 'Amount',
    debit: '',
    credit: '',
    direction: '',
    description: 'Description',
    category: '',
    notes: 'Notes',
    pending: '',
    account: 'Account',
  },
  dateFormat = '%Y-%m-%d',
  amountConvention = 'single_signed',
}) {
  const response = await request.post('/api/import-export/profiles', {
    data: {
      name,
      filename_pattern: 'playwright',
      header_fingerprint: headerFingerprint,
      template_filename: 'playwright-template.csv',
      template_file_hash: `playwright-${Math.random().toString(36).slice(2, 10)}`,
      column_map: columnMap,
      account_id: null,
      date_format: dateFormat,
      amount_convention: amountConvention,
      skip_rows: 0,
      apply_categorization: true,
      notes: null,
    },
  })

  expect(response.ok()).toBeTruthy()
  return (await response.json()).id
}

async function deleteImportProfile(request, id) {
  if (!id) return
  const response = await request.delete(`/api/import-export/profiles/${id}`)
  expect([200, 404]).toContain(response.status())
}

async function expectSharedMappingSuggestions(scope) {
  await expect(scope.getByText('Accept Date')).toBeVisible()
  await expect(scope.getByText('Accept Description')).toBeVisible()
  await expect(scope.getByText('Accept Amount')).toBeVisible()
  await expect(scope.getByText('Accept Account')).toBeVisible()
}

async function clearAllImportProfiles(request) {
  const response = await request.get('/api/import-export/profiles')
  if (!response.ok()) return
  const profiles = await response.json()
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    await deleteImportProfile(request, profile.id)
  }
}

// All specs share one backend/DB per run, so a data source left by a sibling spec makes the import
// page auto-load a saved source and re-render — detaching the transient "Skip" control mid-interaction.
// Start every spec from a clean slate of saved sources.
test.beforeEach(async ({ request }) => {
  await clearAllImportProfiles(request)
})

test('shared mapping suggestions stay aligned between import flow and data source editor', async ({ page }) => {
  await page.goto('/import-export')

  await page.getByRole('button', { name: 'Skip' }).click()
  await page.locator('#csv-file-input').setInputFiles(sampleCsvFile())

  await expectSharedMappingSuggestions(page)
  await expect(page.getByText('temporary draft')).toBeVisible()

  await page.goto('/import-export')
  await page.getByRole('button', { name: 'Manage sources' }).click()
  await expect(page.getByText('Manage data sources')).toBeVisible()
  const managerPanel = page.locator('div')
    .filter({ has: page.getByText('Manage data sources') })
    .filter({ has: page.getByRole('button', { name: 'Close' }) })
    .first()

  // beforeEach clears all saved sources, so the manager always opens on its empty state.
  const createFirst = managerPanel.getByRole('button', { name: '+ Create first data source' })
  await expect(createFirst).toBeVisible()
  await createFirst.click()

  await page.locator('input[type="file"][accept=".csv,text/csv"]').last().setInputFiles(sampleCsvFile())

  await expectSharedMappingSuggestions(page)
  await expect(page.getByText('Using sample-transactions.csv as the template.')).toBeVisible()
})

test('mismatched saved data source can switch to temporary draft without losing explicit suggestions', async ({ page, request }) => {
  const profileName = uniqueDataSourceName('PW mismatch source')
  const profileId = await createImportProfile(request, {
    name: profileName,
  })

  try {
    await page.goto('/import-export')
    await page.getByRole('button', { name: profileName, exact: true }).first().click()
    await page.locator('#csv-file-input').setInputFiles(mismatchedCsvFile())

    await expect(page.getByText('Mismatch detected')).toBeVisible()
    await page.getByRole('button', { name: 'Change data source' }).click()
    // The picker's "use a temporary draft" choice is the "Skip" control.
    await page.getByRole('button', { name: 'Skip' }).click()

    await expect(page.getByRole('button', { name: 'temporary draft' })).toBeVisible()
    await expect(page.getByText('Accept Date')).toBeVisible()
    await expect(page.getByText('Accept Description')).toBeVisible()
    await expect(page.getByText('Accept Amount (in $)')).toBeVisible()
    await expect(page.getByText('Accept Account Name')).toBeVisible()
  } finally {
    await deleteImportProfile(request, profileId)
  }
})

test('editing a data source keeps account mapping explicit until the user accepts the template suggestion', async ({ page, request }) => {
  const profileName = uniqueDataSourceName('PW edit source')
  const profileId = await createImportProfile(request, {
    name: profileName,
    columnMap: {
      date: 'Date',
      amount: 'Amount',
      debit: '',
      credit: '',
      direction: '',
      description: 'Description',
      category: '',
      notes: 'Notes',
      pending: '',
      account: '',
    },
  })

  try {
    await page.goto('/import-export')
    await page.getByRole('button', { name: 'Manage sources' }).click()
    const profileNameButton = page.getByRole('button', { name: profileName, exact: true }).last()
    await profileNameButton.locator('xpath=ancestor::div[2]//button[normalize-space()="Edit"]').click()
    await page.locator('input[type="file"][accept=".csv,text/csv"]').last().setInputFiles(sampleCsvFile())

    await expect(page.getByText('Using sample-transactions.csv as the template.')).toBeVisible()
    await expect(page.getByText('Accept Account')).toBeVisible()

    const saveButton = page.getByRole('button', { name: 'Save changes' })
    await saveButton.click()
    await expect(page.getByText(`Edit: ${profileName}`)).toBeVisible()
    await page.getByText('Accept Account').click()
    await saveButton.click()
    await expect(page.getByText(`Edit: ${profileName}`)).toHaveCount(0)
  } finally {
    await deleteImportProfile(request, profileId)
  }
})

test('deleting a data source from the manager updates the import page list immediately', async ({ page, request }) => {
  const profileName = uniqueDataSourceName('PW delete source')
  const profileId = await createImportProfile(request, { name: profileName })

  try {
    await page.goto('/import-export')
    await expect(page.getByRole('button', { name: profileName, exact: true }).first()).toBeVisible()

    await page.getByRole('button', { name: 'Manage sources' }).click()
    const profileNameButton = page.getByRole('button', { name: profileName, exact: true }).last()
    await profileNameButton.locator('xpath=ancestor::div[2]//button[normalize-space()="×"]').click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.getByRole('button', { name: profileName, exact: true })).toHaveCount(0)
  } finally {
    await deleteImportProfile(request, profileId)
  }
})

test('creating a new mapped account keeps import disabled until the user chooses a type', async ({ page }) => {
  await page.goto('/import-export')

  await page.getByRole('button', { name: 'Skip' }).click()
  await page.locator('#csv-file-input').setInputFiles(newAccountCsvFile())

  for (const suggestion of ['Accept Date', 'Accept Description', 'Accept Amount', 'Accept Account']) {
    await page.getByText(suggestion).click()
  }

  await page.getByRole('button', { name: '+New' }).click()

  const importButton = page.getByRole('button', { name: /Import \d+ rows/ })
  const typeSelect = page.locator('select').filter({
    has: page.locator('option').filter({ hasText: 'Checking' }),
  }).last()

  // The shared Button disables via no-onClick + dimming + cursor:not-allowed (it doesn't set the HTML
  // disabled attribute), so assert that gated state rather than toBeDisabled().
  await expect(importButton).toHaveCSS('cursor', 'not-allowed')
  await expect(typeSelect).toHaveValue('')
  // The disabled reason is surfaced as the import button's tooltip (title), not inline text.
  await expect(page.getByTitle('Choose an account type for "Alias Wallet (...7777)".').first()).toBeVisible()

  await typeSelect.selectOption('depository')
  await expect(importButton).toHaveCSS('cursor', 'pointer')
})
