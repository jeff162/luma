// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The account row's ⋯ menu. Rename and Edit tags are reachable inline as well — by clicking the name,
// and through the tag cell — and the menu exists because those affordances announce themselves only on
// hover, which tells a touch or keyboard user nothing. What matters here is that the menu drives
// *those* editors rather than opening its own: the wiring crosses a component boundary (a page-level
// menu into row-local edit state) through a counter, which is exactly the kind of connection that
// breaks without anything looking wrong.

import { test, expect } from '@playwright/test'

const ACCOUNT = 'Everyday Checking'

// Located by its ⋯ button rather than by `hasText`, because renaming replaces the name with an input
// and an input's value is not text — a hasText row locator stops matching the moment the editor opens.
function accountRow(page, name) {
  return page.locator('[data-account-row]').filter({
    has: page.getByRole('button', { name: `Actions for ${name}` }),
  }).first()
}

async function openRowMenu(page, name) {
  await page.goto('/accounts')
  const row = accountRow(page, name)
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: `Actions for ${name}` }).click()
  return row
}

test('the row menu renames in place rather than opening an editor of its own', async ({ page }) => {
  const row = await openRowMenu(page, ACCOUNT)
  await page.getByRole('menuitem', { name: 'Rename…' }).click()

  // The row's own inline editor, seeded with the current name.
  await expect(row.getByRole('textbox').first()).toHaveValue(ACCOUNT)

  await page.keyboard.press('Escape')
  await expect(row.getByText(ACCOUNT).first()).toBeVisible()
})

test('the row menu opens the tag picker on that row', async ({ page }) => {
  const row = await openRowMenu(page, ACCOUNT)
  await page.getByRole('menuitem', { name: 'Edit tags…' }).click()

  await expect(row.getByRole('button', { name: '+ New tag' })).toBeVisible()
})

test('removal is separated in the menu and names what it cannot undo', async ({ page }) => {
  await openRowMenu(page, ACCOUNT)
  const remove = page.getByRole('menuitem', { name: 'Remove account…' })
  await expect(remove).toBeVisible()

  await remove.click()
  await expect(page.getByText('Remove account?')).toBeVisible()
  await expect(page.getByText(/cannot be undone/i)).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
})
