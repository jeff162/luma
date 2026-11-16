// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The Import page's Connections tab. Two things here cross a boundary nothing else checks: the Tasks
// entries reach the tab through a link string the backend writes, and a connection's account row opens
// the account panel on a page that is not the Accounts page. The demo ledger has no data connection, so
// one is supplied to the browser — the provider listing whole, and one real account marked as fed by it.

import { test, expect } from '@playwright/test'

const ACCOUNT = 'Everyday Checking'
const CONNECTION_ID = 'spec-connection'

async function supplyConnection(page) {
  await page.route('**/api/providers', route => route.fulfill({
    json: {
      providers: [{
        provider: 'simplefin', configured: true, env: null,
        connect_spec: { style: 'token' }, connect_noun: null, requires_app_config: false,
        revokes_on_disconnect: false, stable_external_id: false,
        connections: [{
          id: CONNECTION_ID, provider: 'simplefin', external_id: 'spec-external',
          institution: 'Harborline Bank', has_credential: true, last_synced_at: null,
          last_sync: { outcome: 'ok', added: 3, accounts: { 'spec-account': { added: 3 } } },
        }],
      }],
    },
  }))
  await page.route(`**/api/connections/${CONNECTION_ID}/accounts`, route => route.fulfill({
    json: {
      unmapped: 0,
      accounts: [{ external_account_id: 'spec-account', source_label: 'Harborline Rewards', display_label: 'Harborline Rewards', mapped: true }],
    },
  }))
  await page.route(/\/api\/accounts(\?.*)?$/, async route => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    const accounts = await response.json()
    return route.fulfill({
      response,
      json: accounts.map(a => (a.name === ACCOUNT ? { ...a, connection_id: CONNECTION_ID } : a)),
    })
  })
}

// Whether a provider's card is open is a saved preference, so it outlives the test that set it: open the
// card only if it is not already.
async function openProviderCard(page) {
  const header = page.getByRole('button', { name: /SimpleFIN/ })
  await expect(header).toBeVisible()
  const inside = page.getByRole('button', { name: 'Actions for Harborline Bank' })
  if (!(await inside.isVisible())) await header.click()
  await expect(inside).toBeVisible()
}

// A request still in flight when a test ends would otherwise be reported as that test's failure.
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }) })

test('a ?tab=connections link lands on the Connections tab', async ({ page }) => {
  await supplyConnection(page)
  await page.goto('/import-export?tab=connections')

  await expect(page.getByRole('button', { name: /SimpleFIN/ })).toBeVisible()
  // Consumed, so it cannot override a tab chosen by hand afterwards.
  await expect(page).not.toHaveURL(/tab=/)

  // What the last sync did for each account sits behind the card's own disclosure.
  await openProviderCard(page)
  await expect(page.getByText('Harborline Rewards')).toHaveCount(0)
  await page.getByRole('button', { name: 'Last sync' }).click()
  await expect(page.getByText('Harborline Rewards')).toBeVisible()

})

test('a connection’s account row opens the account panel in place', async ({ page }) => {
  await supplyConnection(page)
  await page.goto('/import-export?tab=connections')

  await openProviderCard(page)
  await page.getByRole('button', { name: 'Accounts (1)' }).click()
  await page.getByTitle(`View ${ACCOUNT}`).click()

  await expect(page.getByText(`Monthly activity — ${ACCOUNT}`)).toBeVisible()
  await expect(page).toHaveURL(/\/import-export$/)
})

test('the Data Import tab offers the sync above the import history, and the page reopens on the tab last chosen', async ({ page }) => {
  await supplyConnection(page)
  await page.goto('/import-export')

  await expect(page.getByText('Import history', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '↻ Sync now' })).toBeVisible()
  await page.getByRole('button', { name: 'Connections (1)' }).click()
  await expect(page.getByRole('button', { name: 'Actions for Harborline Bank' })).toBeVisible()

  await page.getByRole('button', { name: 'File Sources', exact: true }).click()
  await expect(page.getByRole('button', { name: '+ New data source' })).toBeVisible()
  await page.goto('/tasks')
  await page.goto('/import-export')
  await expect(page.getByRole('button', { name: '+ New data source' })).toBeVisible()
})
