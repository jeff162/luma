import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, test } from '@playwright/test'

// Watched folders, end to end through the real stack. The unit tests cover which calls the panel makes
// and which files the scan refuses; what only a browser can show is the join between them — that a file
// nobody uploaded lands in the import history as an ordinary card, and that the refused one hands itself
// back to the *real* import flow when its button is pressed. That second half is the risk worth a
// browser: the panel is mounted above the upload stage and calls the page's own `handleFile`, so it is a
// claim about where the component sits rather than about what it renders.
//
// The folder is a temp directory on this machine, which is also the backend's machine here. Scans are
// driven through the endpoint rather than by waiting for the page's own trigger, because a file has to be
// seen twice before it is read and a spec should not spend that wait on screen.

const HEADER = 'Date,Description,Amount,Account'
const MAPPED = 'Riverstone'
const UNMAPPED = 'Northgate'

function writeAged(dir, name, lines) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, `${[HEADER, ...lines].join('\n')}\n`)
  // Older than the quiet period the scan requires, so the two passes below settle it rather than
  // treating it as a download still being written.
  const past = new Date(Date.now() - 120_000)
  fs.utimesSync(file, past, past)
  return file
}

test('a watched folder imports what it can and hands back what it cannot', async ({ page, request }) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-watch-spec-'))
  const account = await (await request.post('/api/accounts', {
    data: { name: 'Spec Riverstone Checking', type: 'depository' },
  })).json()

  const columnMap = {
    date: 'Date', description: 'Description', amount: 'Amount', account: 'Account',
    account_assignments: { [MAPPED]: account.id },
  }
  const source = await (await request.post('/api/import-export/profiles', {
    data: {
      name: 'Spec Watched Source',
      column_map: columnMap,
      header_fingerprint: HEADER.split(',').join('|'),
      date_format: '%Y-%m-%d',
      amount_convention: 'single_signed',
      apply_categorization: false,
    },
  })).json()

  // A source imports unattended only once one of its files has been imported by hand.
  const proof = await request.post('/api/import-export/run', {
    multipart: {
      file: {
        name: 'spec-watch-proof.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(`${HEADER}\n2026-05-01,Opening balance,1.00,${MAPPED}\n`, 'utf8'),
      },
      config: JSON.stringify({
        profile_id: source.id,
        account_map: { [MAPPED]: account.id },
        column_map: columnMap,
        date_format: '%Y-%m-%d',
        amount_convention: 'single_signed',
        apply_categorization: false,
      }),
    },
  })
  expect(proof.ok()).toBeTruthy()
  const proofBatchId = (await proof.json()).batch_id

  writeAged(folder, 'spec-watch-taken.csv', [`2026-05-04,Hardware store,-54.20,${MAPPED}`])
  writeAged(folder, 'spec-watch-parked.csv', [
    `2026-05-06,Grocery run,-31.10,${MAPPED}`,
    `2026-05-07,Rent,-900.00,${UNMAPPED}`,
  ])

  const watched = await request.patch(`/api/import-export/profiles/${source.id}/watch`, {
    data: { watch_dir: folder, watch_enabled: true },
  })
  expect(watched.ok()).toBeTruthy()

  // First pass records both files, second reads them.
  await request.post('/api/import-export/watch/scan')
  const scanned = await (await request.post('/api/import-export/watch/scan')).json()
  expect(scanned.sources[0].imported).toBe(1)
  expect(scanned.sources[0].parked).toBe(1)

  const batches = await (await request.get('/api/import-export/batches')).json()
  const takenBatchId = (Array.isArray(batches) ? batches : [])
    .find(batch => batch.filename === 'spec-watch-taken.csv')?.id || null
  expect(takenBatchId).toBeTruthy()

  try {
    // The file nobody uploaded is an ordinary card under its data source, reached the ordinary way.
    await page.goto(`/import-export?openBatch=${takenBatchId}`)
    await expect(page.getByText('spec-watch-taken.csv').first()).toBeVisible()

    await page.goto('/import-export')

    // The file it refused is reported with its reason, and offers to finish the job by hand.
    await expect(page.getByText('spec-watch-parked.csv')).toBeVisible()
    await expect(page.getByText(new RegExp(`no account mapped for "${UNMAPPED}"`))).toBeVisible()

    await page.getByRole('button', { name: /Import…/ }).click()

    // The ordinary import flow, holding the file the scan could not take: the upload stage (and with it
    // the panel) is gone, and the mapping grid is asking the question the scan refused to answer.
    await expect(page.getByText('Drop file to import here, or click to browse')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Spec Watched Source', exact: true })).toBeVisible()
    await expect(page.getByText(UNMAPPED).first()).toBeVisible()
  } finally {
    if (takenBatchId) await request.delete(`/api/import-export/batches/${takenBatchId}?force=true`)
    await request.delete(`/api/import-export/batches/${proofBatchId}?force=true`)
    await request.delete(`/api/import-export/profiles/${source.id}`)
    await request.delete(`/api/accounts/${account.id}?transactions=delete`)
    fs.rmSync(folder, { recursive: true, force: true })
  }
})
