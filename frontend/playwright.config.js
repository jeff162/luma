import { defineConfig } from '@playwright/test'
import { getPlaywrightBaseUrl } from './scripts/playwrightBaseUrl.js'

const baseURL = getPlaywrightBaseUrl()
const lightweightMode = process.env.PLAYWRIGHT_LIGHTWEIGHT === '1'

export default defineConfig({
  testDir: './tests/ui',
  testMatch: /.*\.(spec|test)\.[cm]?[jt]s$/,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  outputDir: './test-results',
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
