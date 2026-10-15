import { defineConfig } from '@playwright/test'

import { AUTH_STATE_PATH } from './tests/authState.js'

// Captures the README screenshots (`npm run screenshots`) from the demo ledger into `docs/images/`.
//
// A separate config rather than a project in `playwright.config.js` for the reason the smoke config gives:
// `webServer` is global to a config file, and this one wants its own ports so it never disturbs a test run
// against the main suite's. It is not a test lane and asserts nothing beyond what it needs to wait for. It
// still shares the suite's temp database directory and saved session, so do not run the two at once.
//
// The demo ledger dates its rows back from the day it is loaded, so every run produces different pixels
// even when no page changed. Re-run it when a pictured page has changed visibly, not on every release.
const SHOTS_FRONTEND_PORT = 5197
const SHOTS_BACKEND_PORT = 8097

const baseURL = `http://127.0.0.1:${SHOTS_FRONTEND_PORT}`

export default defineConfig({
  testDir: './tests/screenshots',
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './tests/globalSetup.js',
  webServer: [
    {
      command: 'sh ../scripts/run-e2e-backend.sh',
      env: { E2E_BACKEND_PORT: String(SHOTS_BACKEND_PORT) },
      url: `http://127.0.0.1:${SHOTS_BACKEND_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npm run dev',
      env: { FRONTEND_PORT: String(SHOTS_FRONTEND_PORT), FRONTEND_HOST: '127.0.0.1', BACKEND_PORT: String(SHOTS_BACKEND_PORT) },
      url: baseURL,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
  use: {
    baseURL,
    storageState: AUTH_STATE_PATH,
    headless: true,
    // A laptop window at 1x. The README column is about 880px wide, so GitHub already draws these at
    // roughly 1.6 image pixels per screen pixel; 2x would quadruple the file size for detail it discards.
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  },
})
