import { defineConfig } from '@playwright/test'

import { AUTH_STATE_PATH } from './tests/authState.js'

// The production-bundle smoke pass, deliberately a separate config rather than a project inside
// `playwright.config.js`.
//
// **What it is for.** Three layers already test this app and none of them loads the bundle a user
// actually gets: vitest runs modules through its own transform in jsdom, the main Playwright suite
// drives the *dev* server, and `scripts/smoke_artifact.py` launches the packaged artifact but only far
// enough to answer its health endpoint. So a change to how the app is *built* — a bundler upgrade, a
// chunking rule, a `define` replacement — can break every screen while all three stay green. That is
// not hypothetical: it is the gap a Vite major left open, and the reason this exists.
//
// **Shallow on purpose.** Behaviour is covered by the specs next door; this asks only whether the built
// app loads, routes, and draws. A rarely-run suite that fails for its own reasons gets ignored, and
// then it is worse than nothing — so it stays small enough to trust.
//
// **When to run it:** after changing a build or runtime dependency, and before cutting a release. It is
// out of CI for the same reason the rest of Playwright is: browsers, minutes, and a failure mode that
// wants a person looking at it.
//
// A separate config because `webServer` is global to a config file: this one has to serve `vite build`
// output through `vite preview`, where the main suite deliberately serves the dev server.
const SMOKE_FRONTEND_PORT = 5198
const SMOKE_BACKEND_PORT = 8098

const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL || ''
const baseURL = externalBaseURL || `http://127.0.0.1:${SMOKE_FRONTEND_PORT}`

export default defineConfig({
  testDir: './tests/ui-smoke',
  timeout: 60_000,
  // One worker, and no retries. The pass is short, and a flake that a retry hides is exactly the
  // signal this is here to deliver.
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './tests/globalSetup.js',
  webServer: externalBaseURL ? undefined : [
    {
      command: 'sh ../scripts/run-e2e-backend.sh',
      env: { E2E_BACKEND_PORT: String(SMOKE_BACKEND_PORT) },
      url: `http://127.0.0.1:${SMOKE_BACKEND_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // Built here rather than assumed: a stale `dist/` would let this pass against the previous
      // bundle, which is the one thing it must never do.
      command: `npm run build && npx vite preview --host 127.0.0.1 --port ${SMOKE_FRONTEND_PORT} --strictPort`,
      env: { BACKEND_PORT: String(SMOKE_BACKEND_PORT) },
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  use: {
    baseURL,
    // The session global setup established. Read for browser contexts *and* for the `request`
    // fixture, so an API call from a spec is authenticated the same way a click is.
    storageState: AUTH_STATE_PATH,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
