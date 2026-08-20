import { defineConfig } from '@playwright/test'

// Dedicated, hard-coded E2E ports kept clear of the usual dev ports (5174 / 8001) so the isolated
// stack never collides with a running dev session. The harness boots its OWN backend (throwaway temp
// DB, see scripts/run-e2e-backend.sh) + frontend, so `npm run ui:test` is self-contained and never
// touches the developer's real data. Set PLAYWRIGHT_BASE_URL to instead run against an already-running
// stack (e.g. for fast iteration), which skips the managed servers.
const E2E_FRONTEND_PORT = 5199
const E2E_BACKEND_PORT = 8099

const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL || ''
const baseURL = externalBaseURL || `http://127.0.0.1:${E2E_FRONTEND_PORT}`
const lightweightMode = process.env.PLAYWRIGHT_LIGHTWEIGHT === '1'

const managedServers = externalBaseURL
  ? undefined
  : [
      {
        command: 'sh ../scripts/run-e2e-backend.sh',
        env: { E2E_BACKEND_PORT: String(E2E_BACKEND_PORT) },
        url: `http://127.0.0.1:${E2E_BACKEND_PORT}/api/health`,
        reuseExistingServer: false,
        timeout: 60_000,
      },
      {
        command: 'npm run dev',
        // Win over the developer's .env via vite.config's process-env precedence: own port + proxy to
        // the isolated backend rather than the real one.
        env: { FRONTEND_PORT: String(E2E_FRONTEND_PORT), FRONTEND_HOST: '127.0.0.1', BACKEND_PORT: String(E2E_BACKEND_PORT) },
        url: `http://127.0.0.1:${E2E_FRONTEND_PORT}`,
        reuseExistingServer: false,
        timeout: 60_000,
      },
    ]

export default defineConfig({
  testDir: './tests/ui',
  testMatch: /.*\.(spec|test)\.[cm]?[jt]s$/,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  outputDir: './test-results',
  globalSetup: './tests/globalSetup.js',
  webServer: managedServers,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: './playwright-report' }],
  ],
  use: {
    baseURL,
    headless: true,
    trace: lightweightMode ? 'off' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: lightweightMode ? 'off' : 'retain-on-failure',
  },
})
