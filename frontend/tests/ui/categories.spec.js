import { expect, test } from '@playwright/test'
import { removeFixture } from './cleanup.js'

// Uncategorized income is listed under an "Unassigned" income group that exists only on the page. Saving
// the group order after a create once sent an update for it too, the server answered "Not found", and
// the group was created behind an error that left the name box open. The demo ledger keeps an
// uncategorized income row, so that group is present here.
test('an income group can be created while uncategorized income exists', async ({ page, request }) => {
  const name = `Income Group ${Date.now()}`
  await page.goto('/categories')
  await expect(page.getByText('Other Income', { exact: true })).toBeVisible()

  try {
    await page.getByText('Income', { exact: true }).first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: '+ New income group' }).click()
    await page.getByPlaceholder('Group name').fill(name)
    await page.getByPlaceholder('Group name').press('Enter')

    await expect(page.getByPlaceholder('Group name')).toHaveCount(0)
    await expect(page.getByTitle('Click to rename').filter({ hasText: name })).toBeVisible()
  } finally {
    // Remove the group, so the shared demo baseline is unchanged.
    const categories = await (await request.get('/api/categories')).json()
    const created = categories.find(category => category.name === name)
    if (created) await removeFixture(request, `/api/categories/${created.id}`)
  }
})
