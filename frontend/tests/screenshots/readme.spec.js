import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

// The README screenshots, captured from the demo ledger. Each shot is one test so a page that has changed
// shape fails on its own and the rest still refresh.
const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/images')

// Chrome a real install would not show: the demo banner, and the explainer tips a first visit opens.
test.beforeAll(async ({ request }) => {
  for (const [key, value] of [['ui.help.hintsEnabled', false], ['ui.nav.showDataLocation', false]]) {
    expect(await request.post('/api/auth/preferences', { data: { key, value } })).toBeOK()
  }
  // Detection is a catch-up the app starts on load; run it first so the Recurring page is not racing it.
  expect(await request.post('/api/recurring/auto-scan')).toBeOK()
})

async function hideDemoBanner(page) {
  await page.getByText('Exploring the sample dataset').locator('..').evaluate(el => { el.style.display = 'none' })
}

// Charts animate in; capture once the page has stopped changing rather than mid-transition.
async function settle(page) {
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1500)
}

async function shoot(page, name, options = {}) {
  await hideDemoBanner(page)
  await settle(page)
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), ...options })
}

// Through the nav link rather than goto('/'): the startup-route preference can send "/" elsewhere.
async function openDashboard(page) {
  await page.goto('/')
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
}

test('dashboard', async ({ page }) => {
  await openDashboard(page)
  // The whole page, down to the end of the trend card. The app scrolls an inner pane rather than the
  // document, so a full-page capture would stop at the window; grow the window by what that pane hides.
  await hideDemoBanner(page)
  await settle(page)
  const hidden = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('*')]
    .filter(el => /(auto|scroll)/.test(getComputedStyle(el).overflowY))
    .map(el => el.scrollHeight - el.clientHeight)))
  await page.setViewportSize({ width: 1440, height: 900 + hidden })
  await shoot(page, 'dashboard')
  // GitHub's social preview size, laid out at that width rather than cut from the wider page.
  await page.setViewportSize({ width: 1280, height: 640 })
  await shoot(page, 'social-preview')
})

test('cash flow', async ({ page }) => {
  await openDashboard(page)
  await page.getByRole('button', { name: 'Cash flow' }).click()
  await expect(page.getByText('Cash flow by')).toBeVisible()
  await hideDemoBanner(page)
  await settle(page)
  // The page down to the end of the flow diagram's card; the trend card below it would be cut off.
  const diagram = page.locator('div')
    .filter({ has: page.getByText('Cash flow by') })
    .filter({ has: page.locator('svg') })
    .last()
  const box = await diagram.boundingBox()
  await page.screenshot({
    path: path.join(OUT_DIR, 'cash-flow.png'),
    clip: { x: 0, y: 0, width: 1440, height: Math.ceil(box.y + box.height + 24) },
  })
})

test('transactions', async ({ page }) => {
  await page.goto('/transactions')
  // A row part-way down, so the rows above it still show their categories beside the open picker.
  await page.locator('[title="Click to change category"]').nth(7).click()
  await shoot(page, 'transactions')
})

test('recurring', async ({ page }) => {
  await page.goto('/recurring')
  await page.getByRole('button', { name: /Needs attention/ }).first().click()
  await expect(page.getByRole('button', { name: 'Dismiss' }).first()).toBeVisible()
  // The click leaves the pointer where the filter pills render, which draws one hovered.
  await page.mouse.move(0, 0)
  await shoot(page, 'recurring')
})

test('amazon reconciliation', async ({ page }) => {
  await page.goto('/import-export?tab=history')
  // Expand the Amazon source's row: the innermost element holding both its warning and an expand button.
  await page.locator('div')
    .filter({ has: page.getByTitle(/Some Amazon orders need review/) })
    .filter({ has: page.getByRole('button', { name: '+' }) })
    .last()
    .getByRole('button', { name: '+' })
    .click()
  await page.getByRole('button', { name: /to resolve/ }).click()
  // The floating panel has no dialog role; it is the innermost element holding both its header and its
  // table.
  const dialog = page.locator('div')
    .filter({ has: page.getByText('Amazon reconciliation', { exact: true }) })
    .filter({ has: page.getByRole('button', { name: 'Card charge' }) })
    .last()
  await expect(dialog).toBeVisible()
  // The panel is translucent so the page shows through it, which reads as smudging once cropped.
  await dialog.evaluate(el => { el.style.background = 'var(--surface)' })
  // The click that opened the panel leaves the pointer over its last row, which opens that row's tooltip.
  await page.mouse.move(0, 0)
  await hideDemoBanner(page)
  await settle(page)
  await dialog.screenshot({ path: path.join(OUT_DIR, 'amazon-reconciliation.png') })
})
