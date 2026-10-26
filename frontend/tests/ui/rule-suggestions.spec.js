import { expect, test } from '@playwright/test'

// The Generate Rules review, read-only: which view each suggestion lands in, and the controls that only
// change what is shown (look-back, merchant filter, sort, bulk selection). Nothing here disposes of a
// suggestion, so it runs beside the other specs on the shared demo ledger; the actions that change
// rules and categories are in `rule-suggestions-actions.spec.js`, in a lane of their own.
//
// The demo carries one example per view (`demo_examples.seed_rule_review` and the Hearthside Hardware
// and Harbor Yoga Studio rows in `demo_data`), which is what these tests find by name.

const REVIEW = '/import-export/rule-suggestions'

// A view pill reads like "14 pending" or "✓ 1 accepted"; anchoring on the end keeps it apart from a
// card's "Return suggestion to pending" button.
const pill = (page, word) => page.getByRole('button', { name: new RegExp(`\\d+ ${word}s?$`) })

async function pillCount(page, word) {
  return Number((await pill(page, word).textContent()).match(/\d+/)[0])
}

const card = (page, merchant) => page.locator('[data-rule-suggestion-card]')
  .filter({ has: page.getByRole('button', { name: merchant, exact: true }) })

async function openReview(page) {
  await page.goto(REVIEW)
  await expect(pill(page, 'pending')).toBeVisible()
}

// Look-back and sort order are per-identity preferences, so a test that changes one puts it back.
async function withPreferenceRestored(request, key, fallback, body) {
  const saved = (await (await request.get('/api/auth/preferences')).json()).preferences?.[key]
  try {
    await body()
  } finally {
    await request.post('/api/auth/preferences', { data: { key, value: saved ?? fallback } })
  }
}

test('each settled view holds the decision made there and nothing pending', async ({ page }) => {
  await openReview(page)
  for (const [view, merchant] of [['accepted', 'Fiberlink'], ['deferred', 'Lakeview Pharmacy'], ['discarded', 'Brightline Design — invoice']]) {
    await pill(page, view).click()
    await expect(card(page, merchant)).toBeVisible()
    await expect(card(page, 'Acme Corp Payroll')).toHaveCount(0)
  }
})

test('the conflicts view shows the conflict set, with one choice per imported category', async ({ page }) => {
  await openReview(page)
  await pill(page, 'conflict').click()
  const set = page.locator('[data-rule-suggestion-card]').filter({ hasText: 'Hearthside Hardware' })
  await expect(set).toHaveCount(1)
  await expect(set.getByRole('radio')).toHaveCount(2)
  await expect(set.getByRole('radio', { name: /Home Improvement/ })).toBeVisible()
  await expect(set.getByRole('radio', { name: /Home Repairs/ })).toBeVisible()
  await expect(card(page, 'Acme Corp Payroll')).toHaveCount(0)
})

test('a one-year look-back moves a stale suggestion from pending to older', async ({ page, request }) => {
  await withPreferenceRestored(request, 'ui.importRuleSuggestions.lookbackYears', 2, async () => {
    await openReview(page)
    await expect(card(page, 'Harbor Yoga Studio')).toBeVisible()
    const pendingBefore = await pillCount(page, 'pending')

    await page.getByRole('button', { name: /years? ▾$/ }).click()
    await page.getByRole('button', { name: /^1 year/ }).click()

    await expect.poll(() => pillCount(page, 'pending')).toBe(pendingBefore - 1)
    await expect(pill(page, 'older')).toBeVisible()
    expect(await pillCount(page, 'older')).toBe(1)
    await expect(card(page, 'Harbor Yoga Studio')).toHaveCount(0)

    await pill(page, 'older').click()
    await expect(card(page, 'Harbor Yoga Studio')).toBeVisible()
    await expect(card(page, 'Acme Corp Payroll')).toHaveCount(0)
  })
})

test('the merchant filter narrows the review and clearing it brings everything back', async ({ page }) => {
  await openReview(page)
  const filter = page.getByRole('textbox', { name: 'Filter rule suggestions by merchant name' })
  await filter.fill('transfer')
  await expect(card(page, 'Transfer to Savings')).toBeVisible()
  await expect(card(page, 'Transfer from Checking')).toBeVisible()
  await expect(card(page, 'Acme Corp Payroll')).toHaveCount(0)

  await filter.fill('')
  await expect(card(page, 'Acme Corp Payroll')).toBeVisible()
})

test('sorting by name reorders merchants that sorting by row count put the other way round', async ({ page, request }) => {
  // Northgate Gas has more rows than CellOne Mobile, and sorts after it alphabetically.
  const above = async (first, second) => {
    const [a, b] = await Promise.all([card(page, first).boundingBox(), card(page, second).boundingBox()])
    return a.y < b.y
  }
  await withPreferenceRestored(request, 'ui.importRuleSuggestions.sortOrder', 'row_count', async () => {
    await openReview(page)
    await page.getByRole('button', { name: /▾$/ }).filter({ hasText: /rows|A-Z/ }).click()
    await page.getByRole('button', { name: /^# rows( ✓)?$/ }).click()
    await expect.poll(() => above('Northgate Gas', 'CellOne Mobile')).toBe(true)

    await page.getByRole('button', { name: /▾$/ }).filter({ hasText: /rows|A-Z/ }).click()
    await page.getByRole('button', { name: /^A-Z( ✓)?$/ }).click()
    await expect.poll(() => above('CellOne Mobile', 'Northgate Gas')).toBe(true)
  })
})

test('bulk select all covers only what is visible, and the selection survives a reload', async ({ page }) => {
  await openReview(page)
  await page.getByRole('textbox', { name: 'Filter rule suggestions by merchant name' }).fill('transfer')
  await expect(card(page, 'Acme Corp Payroll')).toHaveCount(0)

  await page.getByRole('button', { name: 'Bulk Select' }).click()
  await expect(page.getByText('0 of 2 selected')).toBeVisible()
  await page.getByRole('button', { name: 'Select all' }).click()
  await expect(page.getByText('2 of 2 selected')).toBeVisible()

  // The filter is page state and does not survive the reload, so the restored selection is seen against
  // the whole pending view: still the same two, and nothing else picked up.
  await page.reload()
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible()
  await expect(page.getByText(/^2 of \d+ selected$/)).toBeVisible()
  await expect(card(page, 'Transfer to Savings').getByRole('checkbox')).toBeChecked()
  await expect(card(page, 'Acme Corp Payroll').getByRole('checkbox')).not.toBeChecked()
})

test('in bulk mode, selecting a conflict set’s lead selects the whole set', async ({ page }) => {
  await openReview(page)
  await page.getByRole('textbox', { name: 'Filter rule suggestions by merchant name' }).fill('hearthside')
  await page.getByRole('button', { name: 'Bulk Select' }).click()
  await expect(page.getByText('0 of 2 selected')).toBeVisible()

  await page.getByRole('checkbox', { name: 'Select this suggestion' }).first().click()
  await expect(page.getByText('2 of 2 selected')).toBeVisible()
})
