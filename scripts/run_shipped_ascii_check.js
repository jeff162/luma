#!/usr/bin/env node

// npm scripts and git hooks need one cross-platform entry point because
// Python is exposed as python3 in WSL/Linux and often python or py on Windows.
const path = require('node:path')

const { runPythonScript } = require('./python-runner')

const repoRoot = path.resolve(__dirname, '..')
const checkScript = path.join(repoRoot, 'scripts', 'check_shipped_ascii.py')

process.exit(runPythonScript(checkScript, process.argv.slice(2)))
