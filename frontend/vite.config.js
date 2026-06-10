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
    // Vitest unit tests run in Node against the pure helpers in src/lib (decision logic with no
    // DOM). Component/interaction coverage stays in the Playwright suite (npm run ui:test).
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
