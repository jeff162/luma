#!/usr/bin/env node

// Pre-commit guard: stored UTC timestamps must come from backend/time_utils.py's `utcnow_iso()`,
// the single chokepoint that keeps them naive-UTC and free of the deprecated `datetime.utcnow()`.
// This blocks the two regressions that quietly reintroduce drift:
//   - `datetime.utcnow()` — deprecated since Python 3.12, and the format we deliberately preserve.
//   - a no-arg `datetime.now()` — returns LOCAL time, silently corrupting UTC-by-convention values.
// Scans only the backend Python files handed to it (pre-commit passes staged ones); `time_utils.py`
// is the one place allowed to call the underlying primitives.

const fs = require('node:fs')

const BANNED = [
  {
    re: /\.utcnow\s*\(/,
    msg: 'datetime.utcnow() is deprecated (3.12+) — use utcnow_iso() from backend.time_utils',
  },
  {
    re: /\bdatetime\.now\s*\(\s*\)/,
    msg: 'datetime.now() returns LOCAL time — use utcnow_iso() from backend.time_utils for stored timestamps',
  },
]

const files = process.argv
  .slice(2)
  .filter((f) => f.endsWith('.py') && f.includes('backend/') && !/backend\/time_utils\.py$/.test(f))

let failed = false
for (const file of files) {
  let contents
  try {
    contents = fs.readFileSync(file, 'utf8')
  } catch {
    continue // a staged-then-deleted path, etc. — nothing to scan
  }
  contents.split(/\r?\n/).forEach((line, i) => {
    const code = line.replace(/#.*$/, '') // ignore trailing comments
    for (const { re, msg } of BANNED) {
      if (re.test(code)) {
        console.error(`${file}:${i + 1}: ${msg}`)
        console.error(`    ${line.trim()}`)
        failed = true
      }
    }
  })
}

if (failed) {
  console.error('\n❌ Timestamp guard failed: route stored timestamps through utcnow_iso().')
  process.exit(1)
}
process.exit(0)
