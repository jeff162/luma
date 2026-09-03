#!/usr/bin/env node

// Pre-commit guard: stored UTC timestamps must come from backend/time_utils.py's `utcnow_iso()`,
// the single chokepoint that keeps them naive-UTC and free of the deprecated `datetime.utcnow()`.
// This blocks the two regressions that quietly reintroduce drift:
//   - `datetime.utcnow()` — deprecated since Python 3.12, and the format we deliberately preserve.
//   - a no-arg `datetime.now()` — returns LOCAL time, silently corrupting UTC-by-convention values.
// Scans the backend Python files handed to it (pre-commit passes staged ones) or, given none, the whole
// backend tree — the same "files if named, otherwise scan all" contract `backend/scripts/check_comments.py`
// uses, which is what lets `npm run lint` cover this. Without the no-args sweep the script exited 0 having
// checked nothing, so a violation survived a green lint and a green suite; only the hook ever saw it, and
// only for files already staged. `time_utils.py` is the one place allowed to call the underlying
// primitives.
//
// A few values genuinely are local time and are not "stored timestamps" at all — a download filename the
// user reads as a date, a ZIP entry's MS-DOS date/time field, which carries no timezone and which every
// archive tool writes and reads as local. Those get a per-line exemption, `# local-time: <reason>`, whose
// reason is mandatory: an exemption that can be applied without saying why is a rubber stamp, and the
// point is to leave the argument where the next reader will see it.
//
// The exemption covers `datetime.now()` only. `datetime.utcnow()` is deprecated in 3.12+ and there is no
// local-time case it could ever be right for, so that half of the guard stays absolute.

const fs = require('node:fs')
const path = require('node:path')

// Mandatory non-empty reason: `# local-time:` alone does not exempt anything.
const LOCAL_TIME_EXEMPTION = /#\s*local-time:\s*\S/

const BANNED = [
  {
    re: /\.utcnow\s*\(/,
    msg: 'datetime.utcnow() is deprecated (3.12+) — use utcnow_iso() from backend.time_utils',
    exemptable: false,
  },
  {
    re: /\bdatetime\.now\s*\(\s*\)/,
    msg: 'datetime.now() returns LOCAL time — use utcnow_iso() from backend.time_utils for stored timestamps',
    exemptable: true,
  },
]

// Two files hold these calls legitimately and are skipped wholesale: `time_utils.py`, the chokepoint
// that wraps the primitives, and this guard's own test, whose fixtures have to quote the very patterns it
// rejects — a test for a lint rule cannot be written without writing the thing the rule forbids. Skipping
// them by path means neither is checked at all, which is the accepted cost: neither stores a timestamp.
const SELF_EXEMPT = [
  /backend\/time_utils\.py$/,
  /backend\/tests\/test_timestamp_guard\.py$/,
]

const REPO_ROOT = path.resolve(__dirname, '..')
const BACKEND_DIR = path.join(REPO_ROOT, 'backend')

// The tree walk skips `venv` and `__pycache__` for the same reason the comment check does: neither holds
// source this project is responsible for, and a virtualenv is large enough to dominate the run.
function walkBackend(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'venv' || entry.name === '__pycache__') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkBackend(full))
    // Relative to the repo root, not to cwd: `npm run lint` invokes this from `frontend/`, and a
    // reported path has to mean the same thing wherever it was run from.
    else if (entry.name.endsWith('.py')) out.push(path.relative(REPO_ROOT, full))
  }
  return out
}

const named = process.argv.slice(2)
const files = (named.length ? named : walkBackend(BACKEND_DIR))
  .filter((f) => f.endsWith('.py') && f.replace(/\\/g, '/').includes('backend/')
    && !SELF_EXEMPT.some((re) => re.test(f.replace(/\\/g, '/'))))

let failed = false
for (const file of files) {
  let contents
  try {
    contents = fs.readFileSync(file, 'utf8')
  } catch {
    continue // a staged-then-deleted path, etc. — nothing to scan
  }
  contents.split(/\r?\n/).forEach((line, i) => {
    // Read the marker off the raw line: the comment is what carries it, and the next step strips comments.
    const exempted = LOCAL_TIME_EXEMPTION.test(line)
    const code = line.replace(/#.*$/, '') // ignore trailing comments
    for (const { re, msg, exemptable } of BANNED) {
      if (!re.test(code)) continue
      if (exemptable && exempted) continue
      console.error(`${file}:${i + 1}: ${msg}`)
      console.error(`    ${line.trim()}`)
      if (exempted && !exemptable) {
        console.error('    (a `# local-time:` exemption does not apply here — this call is never correct)')
      }
      failed = true
    }
  })
}

if (failed) {
  console.error('\n❌ Timestamp guard failed: route stored timestamps through utcnow_iso().')
  console.error('   A value that is genuinely local time takes `# local-time: <reason>` on the same line.')
  process.exit(1)
}
process.exit(0)
