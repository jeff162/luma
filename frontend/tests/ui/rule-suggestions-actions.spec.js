import { expect, test } from '@playwright/test'

// The Generate Rules review's actions: each one writes rules, transaction categories and review state
// together, so these tests check the ledger through the API as well as the page.
//
// They run in their own lane (`rule-review` in playwright.config.js), after every spec that reads the
// demo ledger and before the lane that clears it, and each test starts from a freshly loaded demo. A
// reload rather than undoing each action: undo is one of the behaviors under test, and a broken undo
// used as cleanup would leave its damage for unrelated specs to trip over.

const REVIEW = '/import-export/rule-suggestions'

const pill = (page, word) => page.getByRole('button', { name: new RegExp(`\\d+ ${word}s?$`) })
const pillCount = async (page, word) => Number((await pill(page, word).textContent()).match(/\d+/)[0])
const card = (page, merchant) => page.locator('[data-rule-suggestion-card]')
  .filter({ has: page.getByRole('button', { name: merchant, exact: true }) })

async function openReview(page) {
  await page.goto(REVIEW)
  await expect(pill(page, 'pending')).toBeVisible()
}

async function ruleFor(request, keyword) {
  const rules = await (await request.get(`/api/rules?search=${encodeURIComponent(keyword)}`)).json()
  return rules.find(rule => rule.keyword === keyword) || null
}

async function rowsFor(request, merchant) {
  const response = await request.get(`/api/transactions?search=${encodeURIComponent(merchant)}&limit=0`)
  return (await response.json()).transactions
}

test.beforeEach(async ({ request }) => {
  expect(await request.post('/api/auth/demo-data/clear')).toBeOK()
  const loaded = await request.post('/api/auth/demo-data')
  expect(loaded).toBeOK()
  expect((await loaded.json()).skipped).toBe(false)
})

test('saving a suggestion creates its rule and claims its rows; undo reverses both', async ({ page, request }) => {
  await openReview(page)
  const acceptedBefore = await pillCount(page, 'accepted')

  await card(page, 'Keystone Auto Insurance').getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => pillCount(page, 'accepted')).toBe(acceptedBefore + 1)
  await expect(card(page, 'Keystone Auto Insurance')).toHaveCount(0)
  expect(await ruleFor(request, 'keystone auto insurance')).not.toBeNull()
  expect(new Set((await rowsFor(request, 'Keystone')).map(row => row.category_source))).toEqual(new Set(['rule']))

  await page.getByRole('button', { name: /^↩ Undo/ }).click()
  await expect(card(page, 'Keystone Auto Insurance')).toBeVisible()
  await expect.poll(() => ruleFor(request, 'keystone auto insurance')).toBeNull()
  expect(new Set((await rowsFor(request, 'Keystone')).map(row => row.category_source))).toEqual(new Set(['import']))
})

test('deferring an accepted suggestion undoes the accept: its rule goes and its rows are back as imported', async ({ page, request }) => {
  await openReview(page)
  await pill(page, 'accepted').click()
  expect(await ruleFor(request, 'fiberlink')).not.toBeNull()

  await card(page, 'Fiberlink').getByRole('button', { name: 'Defer', exact: true }).click()
  await expect(card(page, 'Fiberlink')).toHaveCount(0)
  await expect.poll(() => ruleFor(request, 'fiberlink')).toBeNull()
  const rows = await rowsFor(request, 'Fiberlink')
  expect(rows).toHaveLength(13)
  expect(rows.every(row => row.category_name === 'Internet' && row.category_source === 'import')).toBe(true)

  await pill(page, 'deferred').click()
  await expect(card(page, 'Fiberlink')).toBeVisible()
})

test('discarding either keeps the rows’ categories or clears them, as chosen', async ({ page, request }) => {
  await openReview(page)
  await card(page, 'City Power & Light').getByRole('button', { name: 'keep categorization' }).click()
  await expect(card(page, 'City Power & Light')).toHaveCount(0)
  await card(page, 'CellOne Mobile').getByRole('button', { name: 'remove categorization' }).click()
  await expect(card(page, 'CellOne Mobile')).toHaveCount(0)

  const kept = await rowsFor(request, 'City Power')
  expect(kept).toHaveLength(13)
  expect(kept.every(row => row.category_name === 'Electricity' && row.category_source === 'import')).toBe(true)
  const cleared = await rowsFor(request, 'CellOne Mobile')
  expect(cleared).toHaveLength(13)
  expect(cleared.every(row => !row.category_id && row.category_source === 'cleared')).toBe(true)

  await pill(page, 'discarded').click()
  await expect(card(page, 'City Power & Light')).toBeVisible()
  await expect(card(page, 'CellOne Mobile')).toBeVisible()
})

test('resolving a conflict set builds the rule from the chosen category and leaves the other rows as filed', async ({ page, request }) => {
  await openReview(page)
  await pill(page, 'conflict').click()
  const set = page.locator('[data-rule-suggestion-card]').filter({ hasText: 'Hearthside Hardware' })
  await set.getByRole('radio', { name: /Home Improvement/ }).click()
  await set.getByRole('button', { name: 'Apply' }).click()
  await expect(set).toHaveCount(0)

  const rule = await ruleFor(request, 'hearthside hardware')
  expect(rule).not.toBeNull()
  const rows = await rowsFor(request, 'Hearthside Hardware')
  const byCategory = rows.reduce((counts, row) => ({
    ...counts, [`${row.category_name}/${row.category_source}`]: (counts[`${row.category_name}/${row.category_source}`] || 0) + 1,
  }), {})
  expect(byCategory).toEqual({ 'Home Improvement/rule': 4, 'Home Repairs/import': 2 })

  // With both members visible, the settled set reads as one table rather than two cards.
  await pill(page, 'total').click()
  await expect(page.locator('[data-rule-suggestion-card]').filter({ hasText: 'Hearthside Hardware' })).toHaveCount(1)
})

test('in the report, Use majority corrects a row’s file category and Preserve makes it a manual exception', async ({ page, request }) => {
  await openReview(page)
  await pill(page, 'conflict').click()
  await page.locator('[data-rule-suggestion-card]').filter({ hasText: 'Hearthside Hardware' })
    .getByRole('button', { name: 'Open matching transactions report' }).click()
  await expect(page.getByRole('button', { name: 'Use majority' })).toHaveCount(2)

  await page.getByRole('button', { name: 'Use majority' }).first().click()
  await expect(page.getByRole('button', { name: 'Use majority' })).toHaveCount(1)
  await page.getByRole('button', { name: 'Preserve This Categorization' }).click()
  await expect(page.getByRole('button', { name: 'Preserve This Categorization' })).toHaveCount(0)

  const byCategory = (await rowsFor(request, 'Hearthside Hardware')).reduce((counts, row) => ({
    ...counts, [`${row.category_name}/${row.category_source}`]: (counts[`${row.category_name}/${row.category_source}`] || 0) + 1,
  }), {})
  expect(byCategory).toEqual({ 'Home Improvement/import': 5, 'Home Repairs/manual': 1 })
})

test('edits made on a card in place are what saving it sends', async ({ page, request }) => {
  await openReview(page)
  const keystone = card(page, 'Keystone Auto Insurance')

  await keystone.getByRole('button', { name: 'keystone auto insurance', exact: true }).click()
  await keystone.getByRole('textbox').fill('keystone auto')
  await keystone.getByRole('textbox').press('Enter')
  await expect(keystone.getByRole('button', { name: 'keystone auto', exact: true })).toBeVisible()

  await keystone.getByText('category: Auto Insurance').click()
  await page.getByPlaceholder('Auto Insurance').fill('Home Insurance')
  await page.locator('[data-picker-row-active]').filter({ hasText: 'Home Insurance' }).first().click()
  await expect(keystone.getByText('category: Home Insurance')).toBeVisible()

  await keystone.click({ button: 'right' })
  await page.getByRole('menu').getByRole('menuitem', { name: 'Add tag…' }).click()
  await page.getByText('Essential Expenses', { exact: true }).last().click()
  await page.keyboard.press('Escape')
  await expect(keystone.getByRole('button', { name: 'Remove Essential Expenses' })).toBeVisible()

  await keystone.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(keystone).toHaveCount(0)
  const rule = await ruleFor(request, 'keystone auto')
  expect(rule).not.toBeNull()
  expect(rule.category_name).toBe('Home Insurance')
  expect(rule.tags.map(tag => tag.name)).toEqual(['Essential Expenses'])
})

test('narrowing a pending suggestion’s criteria splits it into the matched rows and the rest, creating no rule', async ({ page, request }) => {
  // The demo's gas bills are seasonal and dated from today, so how many reach $100 depends on the date.
  const gas = await rowsFor(request, 'Northgate Gas')
  const atLeast100 = gas.filter(row => Math.abs(row.amount) >= 100).length
  expect(atLeast100).toBeGreaterThan(0)
  expect(atLeast100).toBeLessThan(gas.length)
  await openReview(page)
  await card(page, 'Northgate Gas').getByRole('button', { name: 'Open Rule Editor' }).click()
  await page.getByRole('button', { name: '＋ Amount' }).click()
  await page.getByLabel('Rule lower amount').fill('100')
  await page.getByRole('button', { name: 'Save rule' }).click()

  const cards = card(page, 'Northgate Gas')
  await expect(cards).toHaveCount(2)
  const refined = cards.filter({ hasText: 'at least $100.00' })
  await expect(refined).toContainText(new RegExp(`(?<!\\d)${atLeast100} matching rows?\\b`))
  await expect(refined.getByRole('button', { name: 'Edit selection criteria' })).toBeVisible()
  await expect(cards.filter({ hasNotText: 'at least $100.00' })).toContainText(new RegExp(`(?<!\\d)${gas.length - atLeast100} matching rows?\\b`))
  expect(await ruleFor(request, 'northgate gas')).toBeNull()
})

test('clearing a settled pile sets it aside whole, and restoring it brings it back', async ({ page }) => {
  await openReview(page)
  await pill(page, 'accepted').click()
  await page.getByRole('button', { name: 'Clear accepted' }).click()
  await expect.poll(() => pillCount(page, 'accepted')).toBe(0)
  expect(await pillCount(page, 'cleared set')).toBe(1)

  await pill(page, 'cleared set').click()
  await page.getByRole('button', { name: 'Restore' }).click()
  await expect.poll(() => pillCount(page, 'accepted')).toBe(1)
  await pill(page, 'accepted').click()
  await expect(card(page, 'Fiberlink')).toBeVisible()
})

test('a bulk action applies to the selection and nothing else', async ({ page }) => {
  await openReview(page)
  await page.getByRole('textbox', { name: 'Filter rule suggestions by merchant name' }).fill('transfer')
  await expect(card(page, 'Acme Corp Payroll')).toHaveCount(0)
  await page.getByRole('button', { name: 'Bulk Select' }).click()
  await page.getByRole('button', { name: 'Select all' }).click()
  await page.getByRole('button', { name: 'Defer', exact: true }).first().click()
  await expect(card(page, 'Transfer to Savings')).toHaveCount(0)

  await page.getByRole('textbox', { name: 'Filter rule suggestions by merchant name' }).fill('')
  await expect(card(page, 'Acme Corp Payroll')).toBeVisible()
  await pill(page, 'deferred').click()
  await expect(card(page, 'Transfer to Savings')).toBeVisible()
  await expect(card(page, 'Transfer from Checking')).toBeVisible()
  await expect(card(page, 'Lakeview Pharmacy')).toBeVisible()
  await expect(card(page, 'Acme Corp Payroll')).toHaveCount(0)
})
