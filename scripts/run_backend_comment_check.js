#!/usr/bin/env node

// npm scripts and git hooks need one cross-platform entry point because
// Python is exposed as python3 in WSL/Linux and often python or py on Windows.
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..')
const checkScript = path.join(repoRoot, 'backend', 'scripts', 'check_comments.py')
const backendArgs = process.argv.slice(2)

const candidates = process.platform === 'win32'
  ? [
      ['py', ['-3', checkScript, ...backendArgs]],
      ['python', [checkScript, ...backendArgs]],
      ['python3', [checkScript, ...backendArgs]],
    ]
  : [
      ['python3', [checkScript, ...backendArgs]],
      ['python', [checkScript, ...backendArgs]],
      ['py', ['-3', checkScript, ...backendArgs]],
    ]

for (const [command, args] of candidates) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error?.code === 'ENOENT') {
    continue
  }
  if (result.error) {
    throw result.error
  }
  process.exit(result.status ?? 1)
}

console.error('Python 3 was not found. Install Python 3.12+ and try again.')
process.exit(1)
