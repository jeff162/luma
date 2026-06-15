// E2E seed. The isolated stack boots to a pristine DB, so the app renders the "Getting Started"
// onboarding gate instead of the real pages. The demo-data endpoint both ensures a local preference
// profile exists (clearing that gate — a lone profile auto-selects) AND populates the tenant with the
// explorable demo dataset, so specs land in a realistic, data-rich app. It no-ops on a non-empty DB.
//
// Seeds through the frontend's /api proxy (same path the app uses) once both managed servers are up.
// Skipped when running against an external stack (PLAYWRIGHT_BASE_URL) — that caller owns its own data.

import { request } from '@playwright/test'

export default async function globalSetup(config) {
  if (process.env.PLAYWRIGHT_BASE_URL) return

  const baseURL = config.projects?.[0]?.use?.baseURL || 'http://127.0.0.1:5199'
  const ctx = await request.newContext({ baseURL })
  try {
    const resp = await ctx.post('/api/auth/demo-data')
    if (!resp.ok()) {
      throw new Error(`globalSetup: could not seed demo data (${resp.status()}): ${await resp.text()}`)
    }
  } finally {
    await ctx.dispose()
  }
}
