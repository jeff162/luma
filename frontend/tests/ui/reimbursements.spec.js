import { expect, test } from '@playwright/test'

// Money that went out expecting to come back.
//
// The demo carries three shapes of it deliberately — a work trip repaid in full, a lunch settled the
// same afternoon, and concert tickets where one friend has paid and one has not — and the report is
// where the difference is supposed to show. What it must get right is *subtraction*: a reimbursement
// that has been completed drops off, so what is left on screen is work rather than history. That is the
// assertion here, and it is one no unit test reaches, because it depends on the seeded records, the
// outstanding query and the board rendering agreeing all at once.
//
// Read-only: nothing is completed, matched or dragged, so the shared demo ledger is unchanged.
test('the reimbursements report lists what is still owed and drops what is settled', async ({ page }) => {
  await page.goto('/transactions')
  await page.getByRole('button', { name: 'Reimbursements' }).click()

  // The report panel, located by two things only it has. Scoped rather than asserted against the whole
  // page because the ledger behind the overlay is still in the DOM, and it holds the repayment
  // transactions these records were settled with — including the counterparty names below.
  const report = page.locator('div')
    .filter({ has: page.getByText('Still outstanding') })
    .filter({ has: page.getByRole('button', { name: 'Close' }) })
    .last()

  await expect(report.getByText('Still outstanding')).toBeVisible()
  // Exact: the panel's own description ends "…is expected back", so a substring match on the column
  // heading picks up the blurb above it as well.
  await expect(report.getByText('Expected', { exact: true })).toBeVisible()
  await expect(report.getByText('Received', { exact: true })).toBeVisible()

  // The one debt still open: the second concert ticket. Its record is the reason a claim is per portion
  // — the same charge also carries a paid-off claim, which must not keep the row listed.
  await expect(report.getByRole('button', { name: /Priya Raman/ })).toBeVisible()

  // And the settled ones are gone. The work trip was repaid in full and completed, so naming it here
  // would mean "completed" had not actually removed anything.
  await expect(report.getByText('Northwind Ltd')).toHaveCount(0)
  await expect(report.getByText('Lunch, split three ways')).toHaveCount(0)
})
