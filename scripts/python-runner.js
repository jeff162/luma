// Cross-platform Python discovery, shared by the checks that are written in Python but invoked from
// npm scripts and the git hook. It exists because Python is exposed under a different name depending
// on the platform — `python3` on Linux and macOS, `python` or the `py` launcher on Windows — so any
// single hard-coded name works on one contributor's machine and not the next.
//
// Extracted when the second caller arrived, and the fallback *order* is the part worth having in one
// place: the first name that resolves wins, and a name that is simply absent (ENOENT) moves on to the
// next rather than failing the check. Getting that wrong is silent — the check appears to pass.

const { spawnSync } = require('node:child_process')

/**
 * Run a Python script through whichever interpreter this platform exposes.
 *
 * @param {string} scriptPath Absolute path to the .py file to run.
 * @param {string[]} args Arguments to forward to it.
 * @returns {number} The interpreter's exit status, or 1 if no interpreter was found.
 */
function runPythonScript(scriptPath, args = []) {
  const invocations = process.platform === 'win32'
    ? [['py', ['-3', scriptPath, ...args]], ['python', [scriptPath, ...args]], ['python3', [scriptPath, ...args]]]
    : [['python3', [scriptPath, ...args]], ['python', [scriptPath, ...args]], ['py', ['-3', scriptPath, ...args]]]

  for (const [command, commandArgs] of invocations) {
    const result = spawnSync(command, commandArgs, { stdio: 'inherit' })
    if (result.error?.code === 'ENOENT') {
      continue
    }
    if (result.error) {
      throw result.error
    }
    return result.status ?? 1
  }

  console.error('Python 3 was not found. Install Python 3.12+ and try again.')
  return 1
}

module.exports = { runPythonScript }
