import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_FRONTEND_PORT = 8010

function readFrontendPortFromEnvFile() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const envPath = path.resolve(scriptDir, '../../.env')
  if (!fs.existsSync(envPath)) {
    return null
  }

  const envText = fs.readFileSync(envPath, 'utf8')
  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex === -1) {
      continue
    }

    const key = trimmed.slice(0, separatorIndex).trim()
    if (key !== 'FRONTEND_PORT') {
      continue
    }

    const value = trimmed.slice(separatorIndex + 1).trim()
    const parsedPort = Number.parseInt(value, 10)
    return Number.isFinite(parsedPort) ? parsedPort : null
  }

  return null
}

export function getFrontendPort() {
  const overridePort = Number.parseInt(process.env.FRONTEND_PORT ?? '', 10)
  if (Number.isFinite(overridePort)) {
    return overridePort
  }

  const envFilePort = readFrontendPortFromEnvFile()
  if (Number.isFinite(envFilePort)) {
    return envFilePort
  }

  return DEFAULT_FRONTEND_PORT
}

export function getPlaywrightBaseUrl() {
  if (process.env.PLAYWRIGHT_BASE_URL) {
    return process.env.PLAYWRIGHT_BASE_URL
  }

  return `http://127.0.0.1:${getFrontendPort()}`
}
