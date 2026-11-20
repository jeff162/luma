#!/usr/bin/env node

// Python lint entry point, invoked from `npm run lint` alongside the comment and timestamp checks. It
// covers `backend/` and the build and release scripts in `scripts/`; the rules are in /ruff.toml.
//
// ruff ships as a standalone executable rather than a Python script, so this cannot go through
// python-runner.js (which runs a .py file). Two things make the discovery its own problem:
//
//   * **Where it lives differs by caller.** A developer installs it into the project venv
//     (`backend/venv`, the same one scripts/run_tests.sh requires), which is not on PATH unless the
//     venv is activated. CI pip-installs into the runner's own Python, where it *is* on PATH.
//   * **Exit status cannot be read as discovery.** `python -m ruff` exits 1 both when ruff reported
//     lint errors and when that interpreter has no ruff module at all, so walking a fallback chain on
//     status alone either stops at the wrong candidate or swallows a real failure. Each candidate is
//     therefore probed with `--version` first, and only a candidate that answers runs the check.
//
// Unlike the other lint steps this one has an install prerequisite, since ruff is an optional dev
// dependency rather than something every checkout has. A checkout without it gets a message naming the
// install command, because the alternative (a bare "command not found") reads as a broken repo.

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..')
const targets = [path.join(repoRoot, 'backend'), path.join(repoRoot, 'scripts')]
const isWindows = process.platform === 'win32'

const venvRuff = isWindows
  ? path.join(repoRoot, 'backend', 'venv', 'Scripts', 'ruff.exe')
  : path.join(repoRoot, 'backend', 'venv', 'bin', 'ruff')

// Ordered by how specific each one is to this project: the venv a developer actually installed into,
// then a ruff on PATH (CI), then ruff as a module under whichever interpreter this platform exposes.
const candidates = [
  ...(fs.existsSync(venvRuff) ? [[venvRuff, []]] : []),
  ['ruff', []],
  ...(isWindows
    ? [['py', ['-3', '-m', 'ruff']], ['python', ['-m', 'ruff']], ['python3', ['-m', 'ruff']]]
    : [['python3', ['-m', 'ruff']], ['python', ['-m', 'ruff']], ['py', ['-3', '-m', 'ruff']]]),
]

for (const [command, prefixArgs] of candidates) {
  const probe = spawnSync(command, [...prefixArgs, '--version'], { stdio: 'ignore' })
  if (probe.error || probe.status !== 0) {
    continue
  }
  const result = spawnSync(command, [...prefixArgs, 'check', ...targets], { stdio: 'inherit' })
  if (result.error) {
    throw result.error
  }
  process.exit(result.status ?? 1)
}

console.error('ruff was not found. Install it with:  pip install -r backend/requirements-dev.txt')
process.exit(1)
