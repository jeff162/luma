#!/usr/bin/env node

// Guard against the repo's own real-data rule (`docs/collaboration-notes.md` → what to keep out of UI
// copy, comments and fixtures): an account name, card last-4, or institution belonging to the person
// running this must never reach a tracked file.
//
// **The term list is deliberately not in the repository.** A committed denylist would *be* the
// disclosure — one labelled, greppable place naming every bank and last-4 the rule exists to protect.
// So the list lives in `data/` (gitignored) and this script is the only public half. With no list
// present the check is a no-op, which is the correct behaviour on any other clone and in CI: it
// protects the person whose data it is, not the project.
//
// **It never infers the list from ambient configuration.** Deriving terms from whatever database
// `.env` currently points at fails silently and in the worst direction: with a test database
// configured it derives fabricated names, matches nothing, and exits 0 looking exactly like a pass.
// The list is therefore refreshed only when a database is named explicitly —
// `scripts/refresh-personal-data-terms.py <db>` — and the loaded-term count is printed on every run,
// so "checked nothing" is a visible line rather than a clean exit.

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const REPO_ROOT = path.resolve(__dirname, '..')
const TERMS_FILE = path.join(REPO_ROOT, 'data', 'personal-data-terms.txt')
const ALLOW_FILE = path.join(REPO_ROOT, 'data', 'personal-data-allow.txt')

function readList(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+$/, ''))
      .filter((line) => line && !line.startsWith('#'))
  } catch {
    return null
  }
}

// A digits-only term is a card last-4: bounded by non-digits so it cannot match inside a date, an
// amount or a longer identifier. Anything else is text, matched case-insensitively and bounded only
// where the term's own edge is a word character — "Blue Cash" must not fire on "Blue Cashew", but a
// term ending in punctuation has no boundary to assert.
function toPattern(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (/^\d+$/.test(term)) return new RegExp(`(?<!\\d)${escaped}(?!\\d)`)
  const left = /^\w/.test(term) ? '\\b' : ''
  const right = /\w$/.test(term) ? '\\b' : ''
  return new RegExp(`${left}${escaped}${right}`, 'i')
}

const terms = readList(TERMS_FILE)
if (terms === null) {
  console.log(`Personal-data check: no term list at ${path.relative(REPO_ROOT, TERMS_FILE)} — skipping.`)
  console.log('   (Expected on a clone that is not the data owner\'s. To enable it here, run:')
  console.log('    python3 scripts/refresh-personal-data-terms.py <path-to-your-real.db>)')
  process.exit(0)
}
if (terms.length === 0) {
  console.error(`❌ Personal-data check: ${path.relative(REPO_ROOT, TERMS_FILE)} is empty — nothing was checked.`)
  console.error('   An empty list passes everything. Populate it or delete the file to skip deliberately.')
  process.exit(1)
}

// Paths already known to carry a term and not yet cleaned up. Untracked for the same reason the term
// list is: the pairing of a path with a real name is itself the thing being protected.
const allowed = readList(ALLOW_FILE) || []
const patterns = terms.map((term) => ({ term, re: toPattern(term) }))

// Only tracked content can leak, so the default sweep is `git ls-files` rather than the filesystem —
// which also means the gitignored term list can never scan itself.
const named = process.argv.slice(2)
const files = named.length
  ? named
  : execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)

console.log(`Personal-data check: ${terms.length} terms, ${files.length} files.`)

let failed = false
for (const file of files) {
  const rel = path.relative(REPO_ROOT, path.resolve(REPO_ROOT, file))
  if (allowed.some((prefix) => rel.startsWith(prefix))) continue
  let bytes
  try {
    bytes = fs.readFileSync(path.join(REPO_ROOT, rel))
  } catch {
    continue // deleted or unreadable — nothing to scan
  }
  // Binary is skipped by git's own test, a NUL in the first 8 KB. Decoding it as text would match terms
  // against compressed bytes, where a short term turns up by chance (it did, inside a screenshot's pixels).
  if (bytes.subarray(0, 8000).includes(0)) continue
  const contents = bytes.toString('utf8')
  contents.split(/\r?\n/).forEach((line, i) => {
    for (const { term, re } of patterns) {
      if (!re.test(line)) continue
      console.error(`${rel}:${i + 1}: real personal data — "${term}"`)
      console.error(`    ${line.trim().slice(0, 160)}`)
      failed = true
    }
  })
}

if (failed) {
  console.error('\n❌ Personal-data check failed: replace with fabricated values.')
  console.error('   docs/collaboration-notes.md names the vocabulary to use ("Rewards Card",')
  console.error('   "Cashback Card", "Legacy Card" for cards) and the repo already')
  console.error('   uses Fablecard / Harborline / Riverstone / Northgate with invented masks.')
  console.error('   A path that is a known leftover can be listed in data/personal-data-allow.txt.')
  process.exit(1)
}
console.log('✅ No personal data in tracked files.')
process.exit(0)
