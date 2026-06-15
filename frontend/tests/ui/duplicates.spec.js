import { expect, test } from '@playwright/test'

// The demo seeds the same "Annual Membership" charge on two accounts in two batches; the genuine
// post-import sweep (mark_import_suspects) flags it as a cross-account suspect. It should therefore
// surface as a review task — proving the detection→review pipeline end-to-end (otherwise only
// backend-tested). Read-only: it asserts the suspect is surfaced, without resolving it (which would
// mutate the shared demo DB).
test('a cross-account suspect duplicate surfaces for review in Tasks', async ({ page }) => {
  await page.goto('/tasks')
  await expect(page.getByText('Possible duplicate transactions')).toBeVisible()
  // The count-specific copy confirms the real sweep flagged exactly the one cross-account match seeded.
  await expect(
    page.getByText(/1 transaction matches an existing row on a different account/),
  ).toBeVisible()
})
