import { expect, test } from '@playwright/test'

// The CSV upload flow: how a dropped file is matched to a data source, and what the mapping screen
// offers once it is.
//
// **The flow these cover changed shape.** The upload screen used to open on an explicit data-source
// chooser — every spec here began by pressing "Skip" to take a temporary draft. It is now drop-first:
// the drop zone is the default, and a dropped file's header fingerprint is matched against the saved
// sources automatically (ImportUploadStage's header comment; the rule is
// `findProfilesMatchingPreview`). None matching falls back to a temporary draft, exactly one applies
// straight away, several ask. The chooser still exists, but it is opened on demand — from the drop
// zone's "choose a data source" link, from "Change", or from "Start over" — so a spec that wants an
// explicit source has to open it first.
//
// So detection is now the primary path and gets specs of its own (the three "auto-detect" cases
// below); the explicit chooser is covered where a spec genuinely needs to override detection.
//
// These run in the `import` project, after `demo-clear.setup.js` has emptied the tenant — demo mode
// blocks importing by design. That wipe also clears `csv_import_profile` and `account`, so the phase
// starts with no saved sources and no accounts, which is what lets the "no match" and "+New account"
// cases below be about the flow rather than about leftovers.

// Header fingerprints are pipe-joined by the backend (`ParsedFile.fingerprint`, the one definition
// the preview, the import and the watched-folder scan share) and matched by exact string equality. A profile saved with any other separator matches
// nothing at all, which is a silent pass for a spec asserting "no source was detected" — so the
// fingerprint constants are derived from the header lines right next to them.
const SAMPLE_HEADER = 'Date,Description,Amount,Account,Notes'
const MISMATCHED_HEADER = 'Date,Description,Amount (in $),Account Name,Category'

function fingerprintOf(headerLine) {
  return headerLine.split(',').join('|')
}

const SAMPLE_CSV = `${SAMPLE_HEADER}
2026-01-03,Coffee Shop,-4.75,Checking,Morning run
2026-01-04,Paycheck,1200.00,Checking,Payroll
`

const MISMATCHED_CSV = `${MISMATCHED_HEADER}
2026-02-03,Coffee Shop,-4.75,Checking,Coffee
2026-02-04,Paycheck,1200.00,Checking,Income
`

// Deliberately a name `guessNewAccountTypeFromName` cannot classify (no "checking"/"card"/"savings"/…
// token), so the type select opens empty and the "choose a type" gate below is actually exercised.
const NEW_ACCOUNT_LABEL = 'Alias Wallet (...7777)'

const NEW_ACCOUNT_CSV = `${SAMPLE_HEADER}
2026-03-03,Coffee Shop,-4.75,${NEW_ACCOUNT_LABEL},Morning run
2026-03-04,Paycheck,1200.00,${NEW_ACCOUNT_LABEL},Payroll
`

function csvFile(name, body) {
  return { name, mimeType: 'text/csv', buffer: Buffer.from(body, 'utf8') }
}

// The case the whole mismatch flow exists for: the same export with one column added. Everything the
// saved source maps is still here, so continuing must keep its mapping rather than re-infer.
const EXTENDED_HEADER = `${SAMPLE_HEADER},Reference`

const EXTENDED_CSV = `${EXTENDED_HEADER}
2026-04-03,Coffee Shop,-4.75,Checking,Morning run,R-1
2026-04-04,Paycheck,1200.00,Checking,Payroll,R-2
`

const sampleCsvFile = () => csvFile('sample-transactions.csv', SAMPLE_CSV)
const extendedCsvFile = () => csvFile('extended-transactions.csv', EXTENDED_CSV)
const mismatchedCsvFile = () => csvFile('mismatched-transactions.csv', MISMATCHED_CSV)
const newAccountCsvFile = () => csvFile('new-account-transactions.csv', NEW_ACCOUNT_CSV)

function uniqueDataSourceName(prefix) {
  return `${prefix} ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`
}

async function createImportProfile(request, {
  name,
  headerFingerprint = fingerprintOf(SAMPLE_HEADER),
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

  expect(response, `could not create data source ${name} (${response.status()})`).toBeOK()
  return (await response.json()).id
}

async function deleteImportProfile(request, id) {
  if (!id) return
  const response = await request.delete(`/api/import-export/profiles/${id}`)
  expect([200, 404]).toContain(response.status())
}

async function clearAllImportProfiles(request) {
  const response = await request.get('/api/import-export/profiles')
  // Loud on purpose. Shrugging at a failed response here does not skip a tidy-up — it leaves saved
  // sources in place, the dropped file then auto-detects one of them, and the spec times out much
  // later waiting for a temporary draft that was never taken. The cause and the symptom were thirty
  // seconds and one file apart.
  expect(response, `could not list data sources (${response.status()})`).toBeOK()
  const profiles = await response.json()
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    await deleteImportProfile(request, profile.id)
  }
}

// The four column suggestions inference offers for SAMPLE_HEADER. Their presence means the mapping
// screen guessed; their absence means a saved source supplied the values outright, since
// ImportColumnSelect only offers "Accept X" for a field that has no value yet.
async function expectInferredMappingSuggestions(scope) {
  await expect(scope.getByText('Accept Date')).toBeVisible()
  await expect(scope.getByText('Accept Description')).toBeVisible()
  await expect(scope.getByText('Accept Amount')).toBeVisible()
  await expect(scope.getByText('Accept Account')).toBeVisible()
}

// The chooser card, located by the two things only it has, so that what it offers is asserted inside it.
function sourceChooser(page) {
  return page.locator('div')
    .filter({ has: page.getByText('Available choices') })
    .filter({ has: page.getByRole('button', { name: 'Skip' }) })
    .last()
}

// The upload screen's on-demand data-source chooser. Opened from the drop zone's inline link, which is
// the only way to it on arrival now that the drop zone is the default. Returns the scope above, since
// every assertion about what the chooser offers has to be made inside it.
async function openSourceChooser(page) {
  await page.getByRole('button', { name: 'choose a data source' }).click()
  const chooser = sourceChooser(page)
  await expect(chooser.getByText('Available choices')).toBeVisible()
  return chooser
}

// One row of the File Sources tab's data-source list, located by the two buttons it is guaranteed to hold
// rather than by nesting depth: among the divs containing both, the row itself is the innermost, and
// so the last in document order.
function managerRow(page, profileName) {
  return page.locator('div')
    .filter({ has: page.getByRole('button', { name: profileName, exact: true }) })
    .filter({ has: page.getByRole('button', { name: 'Edit', exact: true }) })
    .last()
}

// All specs in the import phase share one backend and one tenant, so a data source left behind by an
// earlier spec is not inert: the next dropped file auto-detects it. Start each from a clean slate.
test.beforeEach(async ({ request }) => {
  await clearAllImportProfiles(request)
})

test('a dropped file matching no saved source falls back to a temporary draft', async ({ page }) => {
  await page.goto('/import-export')

  // The default upload screen: a drop zone, no chooser, and the auto-detect affordance beside it.
  await expect(page.getByText('Drop file to import here, or click to browse')).toBeVisible()
  await expect(page.getByRole('button', { name: 'choose a data source' })).toBeVisible()

  await page.locator('#csv-file-input').setInputFiles(sampleCsvFile())

  // No saved sources exist, so detection finds nothing and the file lands on a temporary draft with
  // inference offering the columns it could work out.
  await expect(page.getByRole('button', { name: 'temporary draft' })).toBeVisible()
  await expectInferredMappingSuggestions(page)
})

test('an import in progress holds the rest of the app until it is imported or cancelled', async ({ page }) => {
  await page.goto('/import-export')
  await page.locator('#csv-file-input').setInputFiles(sampleCsvFile())
  const mapping = page.getByRole('dialog', { name: 'Import file' })
  await expect(mapping).toBeVisible()

  // A tab or a page chosen now would unmount the importer and lose the mapping, so neither can be reached.
  const reachable = locator => locator.evaluate(el => {
    const box = el.getBoundingClientRect()
    return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
  })
  const tab = page.getByRole('button', { name: 'Connections', exact: true })
  const navLink = page.getByRole('link', { name: 'Transactions' })
  expect(await reachable(tab)).toBe(false)
  expect(await reachable(navLink)).toBe(false)
  await page.keyboard.press('Escape')
  await expect(mapping).toBeVisible()

  await mapping.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(mapping).toHaveCount(0)
  expect(await reachable(tab)).toBe(true)
})

test('a dropped file matching one saved source applies it without asking', async ({ page, request }) => {
  const profileName = uniqueDataSourceName('PW detect source')
  const profileId = await createImportProfile(request, { name: profileName })

  try {
    await page.goto('/import-export')
    await page.locator('#csv-file-input').setInputFiles(sampleCsvFile())

    // Straight to mapping, carrying the matched source — no chooser, no mismatch dialog.
    await expect(page.getByRole('button', { name: profileName, exact: true })).toBeVisible()
    await expect(page.getByText('Which data source?')).toHaveCount(0)
    // The saved column map filled every field, so there is nothing left to suggest. This is what
    // separates "the profile was applied" from "the same columns were guessed".
    await expect(page.getByText(/^Accept /)).toHaveCount(0)
  } finally {
    await deleteImportProfile(request, profileId)
  }
})

// The file input is there from the page's first render, but the saved sources it is matched against
// arrive with the initial load. Holding one of that load's requests open makes the drop land first on
// every run — the ordering CI once hit by chance, where a file set ~15ms after the data arrived was matched
// against the empty list of the render it had been dropped into and silently took a temporary draft.
test('a file dropped before the saved sources load still applies the matching one', async ({ page, request }) => {
  const profileName = uniqueDataSourceName('PW early drop source')
  const profileId = await createImportProfile(request, { name: profileName })
  let releaseInitialLoad
  const initialLoadHeld = new Promise(resolve => { releaseInitialLoad = resolve })
  await page.route(/\/api\/import-export\/batches(\?|$)/, async route => {
    await initialLoadHeld
    await route.continue()
  })

  try {
    await page.goto('/import-export')
    await page.locator('#csv-file-input').setInputFiles(sampleCsvFile())
    releaseInitialLoad()

    await expect(page.getByRole('button', { name: profileName, exact: true })).toBeVisible()
    await expect(page.getByText('Which data source?')).toHaveCount(0)
    await expect(page.getByText(/^Accept /)).toHaveCount(0)
  } finally {
    releaseInitialLoad()
    await deleteImportProfile(request, profileId)
  }
})

test('a dropped file matching several saved sources asks which to use', async ({ page, request }) => {
  const firstName = uniqueDataSourceName('PW ambiguous A')
  const secondName = uniqueDataSourceName('PW ambiguous B')
  const firstId = await createImportProfile(request, { name: firstName })
  const secondId = await createImportProfile(request, { name: secondName })

  try {
    await page.goto('/import-export')
    await page.locator('#csv-file-input').setInputFiles(sampleCsvFile())

    // Each choice's button carries its "possible match" tag in its name, so the match is not exact.
    await expect(page.getByText('Which data source?')).toBeVisible()
    await expect(page.getByRole('button', { name: firstName })).toBeVisible()
    await expect(page.getByRole('button', { name: secondName })).toBeVisible()

    // Skipping the choice is still available, and takes the same temporary draft a non-matching file
    // would have taken.
    await page.getByRole('button', { name: 'Skip' }).click()
    await expect(page.getByRole('button', { name: 'temporary draft' })).toBeVisible()
    await expectInferredMappingSuggestions(page)
  } finally {
    await deleteImportProfile(request, firstId)
    await deleteImportProfile(request, secondId)
  }
})

test('the explicit data source chooser opens on demand and can be dismissed', async ({ page, request }) => {
  const profileName = uniqueDataSourceName('PW chooser source')
  const profileId = await createImportProfile(request, { name: profileName })

  try {
    await page.goto('/import-export')
    const chooser = await openSourceChooser(page)

    // Opening it lists the saved sources alongside the two ways out of using one.
    await expect(chooser.getByRole('button', { name: profileName, exact: true })).toBeVisible()
    await expect(chooser.getByRole('button', { name: 'Skip' })).toBeVisible()
    await expect(chooser.getByRole('button', { name: '+ New data source' })).toBeVisible()

    await page.getByRole('button', { name: 'Cancel — just drop a file' }).click()

    // Back to the default drop-first screen, with detection still in charge.
    await expect(page.getByText('Available choices')).toHaveCount(0)
    await expect(page.getByText('Drop file to import here, or click to browse')).toBeVisible()
  } finally {
    await deleteImportProfile(request, profileId)
  }
})

test('an explicitly chosen source overrides detection and warns when the header does not fit', async ({ page, request }) => {
  const profileName = uniqueDataSourceName('PW mismatch source')
  const profileId = await createImportProfile(request, { name: profileName })

  try {
    await page.goto('/import-export')
    const chooser = await openSourceChooser(page)
    await chooser.getByRole('button', { name: profileName, exact: true }).click()

    // Choosing a source closes the chooser and settles the upload screen back to the drop zone with
    // that source in force.
    await expect(page.getByText('Available choices')).toHaveCount(0)
    await page.locator('#csv-file-input').setInputFiles(mismatchedCsvFile())

    // Detection would have found nothing for this header; the explicit choice is applied anyway, and
    // the verification step is what tells the user the two do not agree.
    await expect(page.getByText('The file header has changed')).toBeVisible()
    await page.getByRole('button', { name: 'Change data source' }).click()
    // In the mismatch chooser, "Skip" is the take-a-temporary-draft choice.
    await page.getByRole('button', { name: 'Skip' }).click()

    await expect(page.getByRole('button', { name: 'temporary draft' })).toBeVisible()
    // Suggestions are re-derived from the file that was actually dropped, not from the source that
    // did not fit it.
    await expect(page.getByText('Accept Date')).toBeVisible()
    await expect(page.getByText('Accept Description')).toBeVisible()
    await expect(page.getByText('Accept Amount (in $)')).toBeVisible()
    await expect(page.getByText('Accept Account Name')).toBeVisible()
  } finally {
    await deleteImportProfile(request, profileId)
  }
})

test('a header that gained a column keeps the source mapping and marks what is new', async ({ page, request }) => {
  const profileName = uniqueDataSourceName('PW extended source')
  const profileId = await createImportProfile(request, { name: profileName })

  try {
    await page.goto('/import-export')
    const chooser = await openSourceChooser(page)
    await chooser.getByRole('button', { name: profileName, exact: true }).click()
    await page.locator('#csv-file-input').setInputFiles(extendedCsvFile())

    await expect(page.getByText('The file header has changed')).toBeVisible()
    await page.getByRole('button', { name: 'Continue' }).click()

    // Continuing applies the source whole. The absence of any "Accept X" is the discriminator:
    // suggestions are only offered for a field with no value, so one appearing would mean the saved
    // mapping had been dropped and the columns guessed back — which is what used to happen.
    await expect(page.getByRole('button', { name: profileName, exact: true })).toBeVisible()
    await expect(page.getByText(/^Accept /)).toHaveCount(0)

    // And the added column is named rather than left to be spotted among the ones always there.
    await expect(page.getByText('The columns in this file are different from what is expected by the data source.')).toBeVisible()
    await expect(page.getByText('Reference', { exact: false }).first()).toBeVisible()
  } finally {
    await deleteImportProfile(request, profileId)
  }
})

test('shared mapping suggestions stay aligned between the import flow and the data source editor', async ({ page }) => {
  await page.goto('/import-export')
  await page.locator('#csv-file-input').setInputFiles(sampleCsvFile())
  await expectInferredMappingSuggestions(page)

  // The same file, loaded as a template in the data-source editor, has to produce the same
  // suggestions: both screens render ImportColumnMappingSection, and that is the point of sharing it.
  await page.goto('/import-export?tab=sources')
  await page.getByRole('button', { name: '+ New data source' }).click()

  await page.locator('input[type="file"][accept=".csv,text/csv"]').last().setInputFiles(sampleCsvFile())

  await expectInferredMappingSuggestions(page)
  await expect(page.getByText('Using sample-transactions.csv as the template.')).toBeVisible()
})

test('a template suggestion stays a suggestion, and the editor will not save until it is accepted', async ({ page, request }) => {
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
    await page.goto('/import-export?tab=sources')
    await managerRow(page, profileName).getByRole('button', { name: 'Edit', exact: true }).click()
    await page.locator('input[type="file"][accept=".csv,text/csv"]').last().setInputFiles(sampleCsvFile())

    await expect(page.getByText('Using sample-transactions.csv as the template.')).toBeVisible()
    await expect(page.getByText('Accept Account')).toBeVisible()

    // Loading the template makes the account column *suggestable*, not mapped — and a saved source that
    // names neither an account column nor a fixed account cannot say where its rows belong, so the
    // editor refuses to store one (`canSave` in ImportProfilesManager). The gate is the assertion: it
    // is what stops a suggestion being treated as an answer nobody gave.
    const saveButton = page.getByRole('button', { name: 'Save changes' })
    await expect(saveButton).toBeDisabled()

    // Accepting is the whole difference between the two states.
    await page.getByText('Accept Account').click()
    await expect(saveButton).toBeEnabled()

    await saveButton.click()
    await expect(page.getByText(`Edit: ${profileName}`)).toHaveCount(0)
  } finally {
    await deleteImportProfile(request, profileId)
  }
})

test('the data source editor can create its account, and saving keeps what imports remembered', async ({ page, request }) => {
  const profileName = uniqueDataSourceName('PW new account source')
  const accountName = uniqueDataSourceName('PW Harborline')
  // What an earlier import wrote back into the source: the editor shows none of it, and must not drop it.
  const accountAssignments = { 'Old Card': 'acct-from-an-earlier-import' }
  const profileId = await createImportProfile(request, {
    name: profileName,
    columnMap: {
      date: 'Date',
      amount: 'Amount',
      description: 'Description',
      notes: 'Notes',
      account_assignments: accountAssignments,
    },
  })

  try {
    await page.goto('/import-export?tab=sources')
    await managerRow(page, profileName).getByRole('button', { name: 'Edit', exact: true }).click()

    await page.getByText('— Select account or column —').click()
    await page.getByText('Create new account…').click()
    const saveButton = page.getByRole('button', { name: 'Save changes' })
    await expect(saveButton).toBeDisabled()
    const newAccountName = page.locator('input[name="single-new-account-name"]')
    await expect(newAccountName).toBeFocused()
    await newAccountName.fill(accountName)
    await saveButton.click()
    await expect(page.getByText(`Edit: ${profileName}`)).toHaveCount(0)

    const accounts = await (await request.get('/api/accounts?include_children=true')).json()
    const created = accounts.find(account => account.name === accountName)
    expect(created, 'saving the source creates the account').toBeTruthy()
    const profiles = await (await request.get('/api/import-export/profiles')).json()
    const saved = profiles.find(profile => profile.id === profileId)
    expect(saved.account_id).toBe(created.id)
    expect(saved.column_map.account_assignments).toEqual(accountAssignments)
  } finally {
    await deleteImportProfile(request, profileId)
    // The last spec here relies on the tenant holding no accounts.
    const accounts = await (await request.get('/api/accounts?include_children=true')).json()
    for (const account of accounts.filter(a => a.name === accountName)) {
      await request.delete(`/api/accounts/${account.id}?transactions=delete`)
    }
  }
})

test('the data source editor re-points, skips and creates the accounts imports remembered', async ({ page, request }) => {
  // A watched folder's files never reach the import screen, so the editor is the only place the map an
  // earlier hand import left behind can be changed.
  const profileName = uniqueDataSourceName('PW account map source')
  const newAccountName = uniqueDataSourceName('PW Tidewater')
  const checking = await (await request.post('/api/accounts', {
    data: { name: uniqueDataSourceName('PW Everyday'), type: 'depository' },
  })).json()
  const card = await (await request.post('/api/accounts', {
    data: { name: uniqueDataSourceName('PW Harborline'), type: 'credit' },
  })).json()
  const profileId = await createImportProfile(request, {
    name: profileName,
    columnMap: {
      date: 'Date',
      amount: 'Amount',
      description: 'Description',
      notes: 'Notes',
      account: 'Account',
      account_assignments: { CHK: checking.id, CARD: checking.id, OLD: card.id },
      account_skips: ['BROKERAGE'],
    },
  })

  try {
    await page.goto('/import-export?tab=sources')
    await managerRow(page, profileName).getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(page.getByText('Account mappings')).toBeVisible()
    const saveButton = page.getByRole('button', { name: 'Save changes' })

    await page.locator('#source-account-map-target-CARD').click()
    await page.getByRole('option', { name: card.name }).click()
    await page.locator('input[name="source-account-map-skip-CHK"]').check()

    // A row left with no account holds the save back until it is mapped or skipped.
    await page.getByRole('button', { name: 'Clear the mapping for OLD' }).click()
    await expect(page.getByText('Choose an account or Skip')).toBeVisible()
    await expect(saveButton).toBeDisabled()
    await page.locator('input[name="source-account-map-skip-OLD"]').check()

    // A new account is created by the save and stored as an ordinary assignment.
    await page.locator('input[name="source-account-map-skip-BROKERAGE"]').uncheck()
    await expect(saveButton).toBeDisabled()
    await page.getByRole('button', { name: '+New' }).click()
    await page.locator('input[name="source-account-map-name-BROKERAGE"]').fill(newAccountName)
    await page.locator('select[name="source-account-map-type-BROKERAGE"]').selectOption('investment')
    await expect(saveButton).toBeEnabled()
    await saveButton.click()
    await expect(page.getByText(`Edit: ${profileName}`)).toHaveCount(0)

    const accounts = await (await request.get('/api/accounts?include_children=true')).json()
    const created = accounts.find(account => account.name === newAccountName)
    expect(created, 'saving the source creates the mapped account').toBeTruthy()
    const profiles = await (await request.get('/api/import-export/profiles')).json()
    const saved = profiles.find(profile => profile.id === profileId)
    expect(saved.column_map.account_assignments).toEqual({ CARD: card.id, BROKERAGE: created.id })
    expect(saved.column_map.account_skips).toEqual(['CHK', 'OLD'])
    expect(saved.column_map.account_new).toBeUndefined()
  } finally {
    await deleteImportProfile(request, profileId)
    // The last spec here relies on the tenant holding no accounts.
    const accounts = await (await request.get('/api/accounts?include_children=true')).json()
    for (const account of accounts.filter(a => [checking.id, card.id].includes(a.id) || a.name === newAccountName)) {
      await request.delete(`/api/accounts/${account.id}?transactions=delete`)
    }
  }
})

test('deleting a data source removes it from the import page immediately', async ({ page, request }) => {
  const profileName = uniqueDataSourceName('PW delete source')
  const profileId = await createImportProfile(request, { name: profileName })

  try {
    await page.goto('/import-export')
    // The saved source is reachable through the on-demand chooser, and listed on the File Sources tab.
    const chooser = await openSourceChooser(page)
    await expect(chooser.getByRole('button', { name: profileName, exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'File Sources', exact: true }).click()
    await managerRow(page, profileName).getByRole('button', { name: '×', exact: true }).click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()

    // Gone from the source list and from the still-open chooser on the other tab, without a reload.
    await expect(page.getByRole('button', { name: profileName, exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Data Import', exact: true }).click()
    await expect(sourceChooser(page).getByText('Available choices')).toBeVisible()
    await expect(page.getByRole('button', { name: profileName, exact: true })).toHaveCount(0)
  } finally {
    await deleteImportProfile(request, profileId)
  }
})

test('creating a new mapped account keeps import disabled until the user chooses a type', async ({ page }) => {
  await page.goto('/import-export')
  await page.locator('#csv-file-input').setInputFiles(newAccountCsvFile())

  for (const suggestion of ['Accept Date', 'Accept Description', 'Accept Amount', 'Accept Account']) {
    await page.getByText(suggestion).click()
  }

  // The phase starts with no accounts, so there is nothing for the matcher to offer and `+New` is a
  // one-press create rather than the "is this the same account?" dialog.
  await page.getByRole('button', { name: '+New' }).click()

  const importButton = page.getByRole('button', { name: /Import \d+ rows/ })
  const typeSelect = page.locator(`select[name="account-map-type-${NEW_ACCOUNT_LABEL}"]`)

  await expect(importButton).toBeDisabled()
  await expect(typeSelect).toHaveValue('')
  // The disabled reason is surfaced as the import button's tooltip (title), not inline text.
  await expect(page.getByTitle(`Choose an account type for "${NEW_ACCOUNT_LABEL}".`).first()).toBeVisible()

  await typeSelect.selectOption('depository')
  await expect(importButton).toBeEnabled()
})

test('a finished import lands on its card in the import history and frees the importer', async ({ page, request }) => {
  await page.goto('/import-export')
  await page.locator('#csv-file-input').setInputFiles(newAccountCsvFile())
  for (const suggestion of ['Accept Date', 'Accept Description', 'Accept Amount', 'Accept Account']) {
    await page.getByText(suggestion).click()
  }
  await page.getByRole('button', { name: '+New' }).click()
  await page.locator(`select[name="account-map-type-${NEW_ACCOUNT_LABEL}"]`).selectOption('depository')
  await page.getByRole('button', { name: /Import \d+ rows/ }).click()

  try {
    // The history under the drop zone shows the card the import wrote, marked, with the summary above it.
    await expect(page.getByText('Import complete')).toBeVisible()
    const batches = await (await request.get('/api/import-export/batches')).json()
    expect(batches).toHaveLength(1)
    const card = page.locator('[data-focused-card="true"]')
    await expect(card).toHaveCount(1)
    await expect(card).toContainText(batches[0].filename)
    await expect(card).toBeInViewport()

    // Scrolled, the summary stays pinned directly under the tab row — no strip between them for the
    // history to show through. A short window, so one card is enough to scroll.
    const notNow = page.getByRole('button', { name: 'Not now' })
    if (await notNow.count()) await notNow.click()
    await page.setViewportSize({ width: 1280, height: 380 })
    const scrolled = await card.evaluate(el => {
      let scroller = el.parentElement
      while (scroller && getComputedStyle(scroller).overflowY !== 'auto') scroller = scroller.parentElement
      scroller.scrollTop = scroller.scrollHeight
      return scroller.scrollTop
    })
    expect(scrolled, 'the history must actually scroll for this to prove anything').toBeGreaterThan(40)
    const tabRow = await page.getByRole('button', { name: 'Data Import', exact: true }).boundingBox()
    const summary = await page.getByText('Import complete').boundingBox()
    expect(summary.y - (tabRow.y + tabRow.height)).toBeLessThan(50)
    expect(summary.y).toBeGreaterThan(tabRow.y + tabRow.height)
    await page.setViewportSize({ width: 1280, height: 720 })

    // The importer was reset behind the landing, so the next file needs nothing dismissed first.
    await page.getByRole('button', { name: 'Import another file' }).click()
    await expect(page.getByText('Import complete')).toHaveCount(0)
    await expect(page.locator('[data-focused-card="true"]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'choose a data source' })).toBeVisible()
  } finally {
    const batches = await (await request.get('/api/import-export/batches')).json()
    for (const batch of batches) await request.delete(`/api/import-export/batches/${batch.id}?force=true`)
    const accounts = await (await request.get('/api/accounts?include_children=true')).json()
    for (const account of accounts) await request.delete(`/api/accounts/${account.id}?transactions=delete`)
  }
})
