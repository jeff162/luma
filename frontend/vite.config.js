import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

function parseSimpleEnvFile(content) {
  const values = {}

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const separatorIndex = line.indexOf('=')
    if (separatorIndex === -1) continue

    const key = line.slice(0, separatorIndex).trim()
    let value = line.slice(separatorIndex + 1).trim()
    if (!key) continue

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    values[key] = value
  }

  return values
}

export default defineConfig(({ mode }) => {
  const projectRoot = path.resolve(process.cwd(), '..')
  const packageJsonPath = path.join(process.cwd(), 'package.json')
  const packageJson = fs.existsSync(packageJsonPath)
    ? JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
    : {}
  const frontendEnv = loadEnv(mode, process.cwd(), '')
  const rootEnvPath = path.join(projectRoot, '.env')
  const rootEnv = fs.existsSync(rootEnvPath)
    ? parseSimpleEnvFile(fs.readFileSync(rootEnvPath, 'utf8'))
    : {}
  // Explicitly-exported process env wins over the .env files (conventional precedence, and what lets
  // the Playwright E2E harness pin its own isolated ports/proxy without editing the developer's .env).
  // Normal `npm run dev` sets none of these, so its behavior is unchanged.
  const processEnvOverrides = {}
  for (const key of ['FRONTEND_PORT', 'FRONTEND_HOST', 'BACKEND_PORT', 'VITE_API_PROXY_TARGET']) {
    if (process.env[key]) processEnvOverrides[key] = process.env[key]
  }
  const env = { ...frontendEnv, ...rootEnv, ...processEnvOverrides }
  const appVersion = env.VITE_APP_VERSION || packageJson.version
  if (!appVersion) {
    throw new Error('No application version: set VITE_APP_VERSION, or a "version" in frontend/package.json.')
  }

  // Defaults match DEFAULT_FRONTEND_PORT / DEFAULT_BACKEND_PORT in backend/runtime_config.py.
  const frontendPort = Number(env.FRONTEND_PORT || 8010)
  // Loopback unless FRONTEND_HOST says otherwise. The dev server used to bind every interface, which put
  // it on the LAN by default — and an esbuild advisory (GHSA-67mh-4wv8-2f99) lets any page the developer
  // visits read from it, so the wide bind is worth opting into rather than out of. `localhost` and not
  // `127.0.0.1`: the browser's origin becomes the WebAuthn Relying Party id, and an address is not a
  // domain, so the numeric form disables passkey vault slots in development.
  const frontendHost = env.FRONTEND_HOST || 'localhost'
  const apiProxyTarget = env.VITE_API_PROXY_TARGET || `http://localhost:${env.BACKEND_PORT || 8011}`

  return {
    plugins: [react()],
    // Vitest tests default to the Node environment (pure helpers in src/lib — decision logic with no
    // DOM). A test that needs the DOM (component/interaction coverage via @testing-library/react)
    // opts in per-file with a `// @vitest-environment jsdom` directive on the first line, so the
    // default suite stays fast and DOM-free. Convention: each test lives in a `__tests__/` folder
    // beside the code it covers (e.g. src/lib/__tests__/foo.test.js for src/lib/foo.js) — colocated
    // for proximity/refactor-safety but kept out of the module's own listing. The glob below stays
    // deliberately broad (any depth) rather than pinned to `__tests__/` so a misplaced test still
    // RUNS instead of being silently skipped; placement is kept right by review. Full end-to-end
    // browser coverage stays in the Playwright suite under tests/ui/*.spec.js (npm run ui:test).
    test: {
      environment: 'node',
      include: ['src/**/*.test.{js,jsx}'],
      setupFiles: ['./vitest.setup.js'],
    },
    define: {
      // No literal fallback on purpose. A stale hardcoded version is worse than a failed build: it ships
      // a UI reporting a version the API and the artifact filename disagree with, and nothing surfaces
      // it. The authoritative value is APP_VERSION in backend/runtime_config.py, which
      // backend/tests/test_app_version.py holds this package.json in step with.
      __APP_VERSION__: JSON.stringify(appVersion),
    },
    build: {
      rollupOptions: {
        output: {
          // Isolate the heavy, slow-changing vendor libraries into their own long-cached chunks
          // instead of letting them ride inside whichever app chunk happens to be their common
          // ancestor. Recharts (+ its d3/victory dependency tree) is by far the largest dependency
          // and is shared between the Dashboard and the detail-panel trend charts (via
          // detailShared.jsx); pulling it out keeps the app-code chunks (detailShared, Dashboard)
          // at their true size and lets the chart bundle stay cached across deploys that only touch
          // app code. React is split the same way for the same reason.
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined
            if (/[\\/]node_modules[\\/](recharts|d3-[^\\/]+|victory-vendor|internmap|decimal\.js-light|reduce-css-calc)[\\/]/.test(id)) {
              return 'charts'
            }
            if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
              return 'react-vendor'
            }
            return undefined
          },
        },
      },
    },
    server: {
      host: frontendHost,
      port: frontendPort,
      proxy: {
        '/api': apiProxyTarget
      }
    },
    // `vite preview` serves the *built* bundle, and it does not inherit `server`. Without the same
    // proxy every API call from a preview is a 404, so the one context that exercises what actually
    // ships would be the one context the app cannot run in. Port and host are left to the caller
    // (the smoke config passes them) so an ordinary `npm run preview` keeps Vite's own defaults.
    preview: {
      proxy: {
        '/api': apiProxyTarget
      }
    }
  }
})
