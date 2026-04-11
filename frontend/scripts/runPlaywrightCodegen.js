import { spawn } from 'node:child_process'
import { getPlaywrightBaseUrl } from './playwrightBaseUrl.js'

const baseUrl = getPlaywrightBaseUrl()
const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const child = spawn(npxCommand, ['playwright', 'codegen', baseUrl], {
  stdio: 'inherit',
})

child.on('exit', code => {
  process.exit(code ?? 0)
})

child.on('error', error => {
  console.error(error)
  process.exit(1)
})
