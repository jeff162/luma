import { expect, test } from '@playwright/test'

// `Rule checkup` on the Rules page: everything wrong with the rule set, in one panel.
//
// Three situations, treated differently, which is the whole point of it. A charge that drifted out of a
// rule's amount range is *news* — it arrived in the ledger and quietly stopped being categorized — and
// it is the half the control badges. Two amount ranges that meet are a *problem*: nothing decides which
// rule wins, so those cannot even be dismissed. Two merchant matchers where one nests inside the other
// are *information* — the narrower one wins, and saying so is the service. The demo seeds all three
// deliberately, because the checks have nothing to report on a tidy rule set and would otherwise only
// ever be seen empty.
//
// Read-only: nothing is widened, dismissed, deleted or edited, so the shared demo rule set is unchanged.
test('the rule checkup tells drifted ranges, ambiguous rules and merely nested ones apart', async ({ page }) => {
  await page.goto('/rules')
  await page.getByRole('button', { name: /Rule checkup/ }).click()

  await expect(page.getByText('Rule checkup', { exact: true }).last()).toBeVisible()

  // Each section renders only when its check found something, so all three being present is the
  // assertion that the seeded cases were told apart rather than lumped together.
  await expect(page.getByText(/Charges outside a rule/)).toBeVisible()
  await expect(page.getByText('Amount ranges that overlap')).toBeVisible()
  await expect(page.getByText('Merchant matchers that nest')).toBeVisible()

  // The header counts the open set from each server tally. The parts are counted separately because they
  // are not the same kind of thing: the first two are work, the last is there to be read.
  await expect(page.getByText(/\d+ charges? outside a range · \d+ to settle · \d+ for information/)).toBeVisible()
})
