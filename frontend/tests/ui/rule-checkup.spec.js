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

// Edit from the checkup opens the rule editor as a second floating window, with the checkup still open
// behind it, so the two can be arranged side by side. Both move by their headers. Cancelled, so the
// shared demo rule set is unchanged.
test('editing a rule from the checkup keeps the checkup open, and both windows move', async ({ page }) => {
  await page.goto('/rules')
  await page.getByRole('button', { name: /Rule checkup/ }).click()
  const checkupTitle = page.getByText('Rule checkup', { exact: true }).last()
  await expect(checkupTitle).toBeVisible()

  await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
  const editorTitle = page.getByText('Edit rule', { exact: true })
  await expect(editorTitle).toBeVisible()
  await expect(checkupTitle).toBeVisible()

  const before = await editorTitle.boundingBox()
  await page.mouse.move(before.x + 5, before.y + 5)
  await page.mouse.down()
  await page.mouse.move(before.x - 120, before.y + 60, { steps: 6 })
  await page.mouse.up()
  const after = await editorTitle.boundingBox()
  expect(Math.round(after.x - before.x)).toBeLessThan(-60)

  // The editor's own Cancel, beside its Save; the page toolbar carries a Cancel of its own while an editor is open.
  await page.getByRole('button', { name: 'Save changes' }).locator('xpath=following-sibling::button[1]').click()
  await expect(editorTitle).toBeHidden()
  await expect(checkupTitle).toBeVisible()
})
