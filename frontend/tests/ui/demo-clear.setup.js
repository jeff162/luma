import { expect, test } from '@playwright/test'

// Phase boundary, not a test.
//
// Two lanes want an empty tenant and the rest want the demo ledger, and the two cannot be told apart by
// a command-line filter — Playwright does not apply `--grep` to a dependency project, so a lane excluded
// on the command line still runs as somebody's dependency (see `playwright.config.js`). They have to be
// ordered instead, and this is the boundary the ordering hangs off.
//
// **The a11y sweep already cleared the demo data for itself** (`a11y-import-export-audit.spec.js`), which
// is exactly the wipe that must not land mid-run beside the specs reading the ledger. Hoisting it here
// makes it happen once, at a point where nothing else is in flight.
//
// The import specs want the same empty tenant for a different reason: while demo data is loaded the drop
// zone is disabled and the screen says so, and a spec that pushed a file through the hidden input anyway
// would be exercising a path the user cannot take.
//
// The endpoint refuses unless the demo marker is present, so it cannot reach real data, and it re-seeds
// the group skeleton — which is the clean slate both lanes want anyway.
test('clear the demo data so the import phase can import', async ({ request }) => {
  const response = await request.post('/api/auth/demo-data/clear')
  expect(response, `could not clear the demo data (${response.status()})`).toBeOK()
})
