import { defineConfig } from '@playwright/test'

import { AUTH_STATE_PATH } from './tests/authState.js'

// Dedicated, hard-coded E2E ports kept clear of the default dev ports (8010 / 8011) so the isolated
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
  // Has to leave room for the expect budget below plus the work around it: at 30s a single assertion
  // spending its full 20 would blow the test timeout instead, turning a clear "waiting for X" into an
  // opaque "test timeout exceeded". Move the two together.
  timeout: 60_000,
  expect: {
    // Longer than the backend's own `_BUSY_TIMEOUT_SECONDS` (15s, backend/db/database.py), and that
    // relationship is the whole point rather than a round number. SQLite's WAL serializes writers, so
    // the app is *designed* to wait up to fifteen seconds for a write lock and then succeed. An expect
    // budget of ten therefore called a deliberately-absorbed wait a failure — the test was less patient
    // than the thing it was testing, which is a bug in the test however rarely it fires.
    //
    // This is a ceiling on a hang, not a tolerance for slowness: a passing assertion still resolves in
    // milliseconds, and nothing here asserts anything about latency. Raise the backend's busy timeout
    // and this has to move with it.
    timeout: 20_000,
  },
  outputDir: './test-results',
  globalSetup: './tests/globalSetup.js',
  // Lanes are **projects, not `--grep`**, and that is load-bearing rather than a style choice.
  //
  // One spec in the a11y sweep clears the demo data so it can drive the import screen with the drop
  // zone enabled (`a11y-import-export-audit.spec.js`). That wipe is fine on its own and fatal beside
  // the dozen specs that read the demo ledger — so the two have to be *ordered*, not merely told apart.
  //
  // `--grep-invert @a11y` used to keep them apart and cannot do it once dependencies exist: Playwright
  // does not apply command-line grep filters to a dependency project, so a lane excluded on the command
  // line runs anyway as somebody's dependency, and the wipe lands in the middle of everything else.
  // Selecting projects is the filter that survives that, so the npm scripts pass `--project`.
  //
  // The order is one-way by construction and the phases never overlap: `app` reads the demo ledger, a
  // setup spec clears it, then the lanes that want an empty tenant run one after the other. Within a
  // phase specs still run in parallel as before.
  //
  // **`a11y` is chained behind `import` (through `marketplace`) rather than beside it**, which costs a few seconds and buys the
  // removal of a whole class of failure. Both lanes clear the saved data sources to reach a known-empty
  // manager, and run side by side they delete each other's: a spec that has selected a source watches it
  // vanish, the page drops the selection it no longer has (ImportExport.jsx, "drop a selected source
  // that no longer exists"), and the next dropped file quietly takes the auto-detect path instead. The
  // symptom is a spec that passes alone and fails in company, which is the expensive kind to chase.
  projects: [
    {
      name: 'app',
      // Every session shares one backend process, and past about three at once its requests slow each
      // other down until pages miss their deadlines: docs/scale-and-limits.md → "Many sessions on one
      // server". `npm run ui:stress` raises it to 10 through PLAYWRIGHT_APP_WORKERS to measure exactly that.
      workers: Number(process.env.PLAYWRIGHT_APP_WORKERS) || 3,
      testIgnore: /(a11y-.*|import-mapping-controls|import-not-imported-rows|watched-folders|reconciliation-report|paypal-statement-import)\.spec\.js/,
    },
    {
      name: 'demo-cleared',
      testMatch: /demo-clear\.setup\.js/,
      dependencies: ['app'],
    },
    {
      name: 'import',
      testMatch: /import-mapping-controls\.spec\.js/,
      dependencies: ['demo-cleared'],
    },
    // Chained behind `import` for the same reason as `a11y`: these add accounts and import batches to
    // the empty tenant, which the mapping specs assume holds none. Each spec removes its own when it
    // finishes.
    {
      name: 'import-report',
      testMatch: /import-not-imported-rows\.spec\.js/,
      dependencies: ['import'],
    },
    // Its own lane rather than beside `import-report`: this one points the *server* at a temp folder and
    // imports from it without a browser upload, so it must not be interleaved with a spec that is
    // counting the cards in the same empty tenant.
    {
      name: 'watched-folders',
      testMatch: /watched-folders\.spec\.js/,
      dependencies: ['import-report'],
    },
    {
      name: 'marketplace',
      testMatch: /(reconciliation-report|paypal-statement-import)\.spec\.js/,
      dependencies: ['watched-folders'],
    },
    {
      name: 'a11y',
      testMatch: /a11y-.*\.spec\.js/,
      dependencies: ['marketplace'],
    },
  ],
  webServer: managedServers,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: './playwright-report' }],
  ],
  use: {
    baseURL,
    // The session global setup established. Read for browser contexts *and* for the `request`
    // fixture, so an API call from a spec is authenticated the same way a click is.
    storageState: AUTH_STATE_PATH,
    headless: true,
    trace: lightweightMode ? 'off' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: lightweightMode ? 'off' : 'retain-on-failure',
  },
})
