import { expect, test } from '@playwright/test'

// A PayPal statement dropped on the general importer: the page sends a PDF to the statement import rather
// than the CSV mapping, the dialog asks which PayPal account the statement's PayPal account goes into, and
// the import lands as a card under the PayPal data source. Reading a statement row by row is pinned in the
// backend tests; what only the real tree shows is that routing and the dialog are wired together.
//
// Runs in the `marketplace` project, after the demo data is cleared — demo mode refuses imports.

// A one-page statement laid out as PayPal prints one, with text placed at points so the reader sees
// columns. Written byte by byte with a correct cross-reference table, as backend/tests/_pdf_fixture.py is.
function statementPdf() {
  const placed = [
    [20, 770, 'ACCOUNT STATEMENTS'], [20, 758, 'Vale, Robin'],
    [30, 735, 'Statement Period'], [200, 735, 'PayPal Account ID'],
    [30, 722, 'Mar 1, 2026 - Mar 31,'], [30, 712, '2026'], [200, 722, 'spec-statement@example.com'],
    [20, 690, 'PAYPAL ACCOUNT'], [20, 670, 'ACCOUNT ACTIVITY'],
    [20, 655, 'DATE'], [110, 655, 'DESCRIPTION'], [330, 655, 'CURRENCY'], [400, 655, 'AMOUNT'], [470, 655, 'FEES'], [540, 655, 'TOTAL*'],
    [20, 635, '03/14/2026'], [110, 635, 'Mobile Payment: Trail Club'], [330, 635, 'USD'], [400, 635, '-17.25'], [470, 635, '0.00'], [540, 635, '-17.25'],
    [110, 625, 'ID: 9SPEC000000000001'],
  ]
  const stream = placed.map(([x, y, text]) => `BT /F1 8 Tf 1 0 0 1 ${x} ${y} Tm (${text}) Tj ET\n`).join('')
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[4 0 R]/Count 1>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 5 0 R/Resources<</Font<</F1 3 0 R>>>>>>',
    `<</Length ${stream.length}>>stream\n${stream}endstream`,
  ]
  let out = '%PDF-1.4\n'
  const offsets = objects.map((body, i) => {
    const at = out.length
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
    return at
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  out += offsets.map(at => `${String(at).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

test('a dropped PayPal statement imports into the PayPal account chosen for it', async ({ page, request }) => {
  const paypal = await (await request.post('/api/accounts', { data: { name: 'Spec Statement PayPal', type: 'paypal' } })).json()
  let batchId = null
  try {
    await page.goto('/import-export')
    await page.locator('#csv-file-input').setInputFiles({ name: 'statement-Mar-2026.pdf', mimeType: 'application/pdf', buffer: statementPdf() })

    await expect(page.getByText('Import PayPal statements')).toBeVisible()
    await expect(page.getByText('1 transaction', { exact: true })).toBeVisible()
    await page.getByRole('combobox', { name: 'Account for spec-statement@example.com' }).selectOption({ label: 'Spec Statement PayPal' })
    await page.getByRole('button', { name: 'Import statements' }).click()
    await expect(page.getByText(/— 1 imported/)).toBeVisible()
    await page.getByRole('button', { name: 'Done' }).click()

    const batches = await (await request.get('/api/import-export/batches')).json()
    const card = batches.find(b => b.filename === 'statement-Mar-2026.pdf')
    expect(card?.source_kind).toBe('source:paypal')
    batchId = card?.id
  } finally {
    if (batchId) await request.delete(`/api/import-export/batches/${batchId}?force=true`)
    await request.delete(`/api/accounts/${paypal.id}?transactions=delete`)
  }
})
