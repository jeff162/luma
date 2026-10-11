import { expect, test } from '@playwright/test'

test('import page loads', async ({ page }) => {
  await page.goto('/import-export')
  await expect(page.getByRole('heading', { name: 'Import', exact: true })).toBeVisible()
})
