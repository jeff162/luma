import { expect } from '@playwright/test'

// Removes something a spec created, from its `finally`. The status is checked, softly: a cleanup the
// server refuses is a server bug the spec would otherwise pass over, but a hard failure here would replace
// the body's own error and skip the rest of the cleanup.
export async function removeFixture(request, url) {
  const response = await request.delete(url)
  expect.soft(response.ok(), `DELETE ${url} answered ${response.status()}`).toBe(true)
  return response
}
