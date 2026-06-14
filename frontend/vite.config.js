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
  const env = { ...frontendEnv, ...rootEnv }
  const frontendPort = Number(env.FRONTEND_PORT || 5173)
  const apiProxyTarget = env.VITE_API_PROXY_TARGET || `http://localhost:${env.BACKEND_PORT || 8000}`

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
    },
    define: {
      __APP_VERSION__: JSON.stringify(env.VITE_APP_VERSION || packageJson.version || '0.2.0'),
    },
    server: {
      host: '0.0.0.0',
      port: frontendPort,
      proxy: {
        '/api': apiProxyTarget
      }
    }
  }
})
