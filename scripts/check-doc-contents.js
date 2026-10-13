#!/usr/bin/env node

// Keeps the documentation's tables of contents true, and builds the index of all of it.
//
// Two things are generated from the headings, because both go stale the moment a heading is renamed and
// nothing else in the repository would notice:
//   - the `## Contents` list inside a document that has one. A document opts in by having that heading;
//     one without it is left alone.
//   - `docs/README.md`, the index of every document in `docs/` with its sections. GitHub shows that file
//     when the folder is opened.
//
// With no arguments this checks and exits nonzero on drift, which is how `npm run lint` runs it.
// `--write` regenerates whatever is out of date and leaves the rest untouched, so a list that is
// already correct keeps the spacing and bullet style its author gave it.
//
// A contents list is correct when every link in it resolves to a heading in that file, every `##`
// heading is listed, and the entries are in document order. Listing `###` headings is the document's
// choice: a list that already nests them keeps them on a rewrite, one that does not stays flat.
//
// The index says what is *in* each document. It does not say which document answers a question; the
// hand-written lists in `AGENTS.md` and the README's *Documentation* section do that.

const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')
const DOCS_DIR = path.join(REPO_ROOT, 'docs')
const INDEX_PATH = path.join(DOCS_DIR, 'README.md')
const CONTENTS_HEADING = 'Contents'

// Documents outside `docs/` whose contents lists are held to the same check. They are not in the index.
const ROOT_DOCUMENTS = ['README.md', 'CONTRIBUTING.md']

// GitHub's anchor for a heading: the text with its inline markup dropped, lowercased, everything but
// letters, digits, spaces, hyphens and underscores removed, and spaces turned to hyphens. A repeated
// heading gets `-1`, `-2` and so on, which `seen` tracks per document.
function slugify(text, seen) {
  const plain = text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
  const base = plain.toLowerCase().replace(/[^\p{L}\p{N}\- _]/gu, '').replace(/ /g, '-')
  const count = seen.get(base) || 0
  seen.set(base, count + 1)
  return count === 0 ? base : `${base}-${count}`
}

// `##` and `###` headings in document order, skipping fenced code, where a `#` line is a shell comment.
function readHeadings(text) {
  const headings = []
  const seen = new Map()
  let fenced = false
  let title = null
  for (const line of text.split('\n')) {
    if (/^(```|~~~)/.test(line)) { fenced = !fenced; continue }
    if (fenced) continue
    const match = /^(#{1,6}) +(.+?)\s*$/.exec(line)
    if (!match) continue
    const level = match[1].length
    const anchor = slugify(match[2], seen)
    if (level === 1 && title === null) title = match[2]
    if (level === 2 || level === 3) headings.push({ level, text: match[2], anchor })
  }
  return { title, headings }
}

// The lines of the existing `## Contents` section, as a [start, end) range of line indexes that covers
// the list and stops before whatever follows it (the next heading, or a rule that closes the intro).
function findContents(lines) {
  const start = lines.findIndex(line => line.trim() === `## ${CONTENTS_HEADING}`)
  if (start === -1) return null
  let end = start + 1
  while (end < lines.length && !/^(#{1,6} |---\s*$)/.test(lines[end])) end += 1
  return { start, end }
}

function listedAnchors(sectionLines) {
  const entries = []
  for (const line of sectionLines) {
    const match = /^(\s*)[-*] +\[[^\]]*\]\(#([^)]+)\)/.exec(line)
    if (match) entries.push({ nested: match[1].length > 0, anchor: match[2] })
  }
  return entries
}

function renderContents(headings, withSubsections) {
  const out = [`## ${CONTENTS_HEADING}`, '']
  for (const heading of headings) {
    if (heading.level === 3 && !withSubsections) continue
    out.push(`${heading.level === 3 ? '  ' : ''}- [${heading.text}](#${heading.anchor})`)
  }
  out.push('')
  return out
}

// What is wrong with a document's contents list, as messages; empty when it is correct.
function contentsProblems(entries, headings) {
  const problems = []
  const byAnchor = new Map(headings.map((heading, index) => [heading.anchor, index]))
  let last = -1
  for (const entry of entries) {
    if (!byAnchor.has(entry.anchor)) {
      problems.push(`links to #${entry.anchor}, which is not a heading`)
      continue
    }
    if (byAnchor.get(entry.anchor) < last) problems.push(`#${entry.anchor} is out of document order`)
    last = Math.max(last, byAnchor.get(entry.anchor))
  }
  const listed = new Set(entries.map(entry => entry.anchor))
  for (const heading of headings) {
    if (heading.level === 2 && !listed.has(heading.anchor)) problems.push(`does not list "${heading.text}"`)
  }
  return problems
}

function checkDocument(file, write) {
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split('\n')
  const range = findContents(lines)
  if (!range) return []
  const headings = readHeadings(text).headings.filter(heading => heading.text !== CONTENTS_HEADING)
  const entries = listedAnchors(lines.slice(range.start, range.end))
  const problems = contentsProblems(entries, headings)
  if (problems.length && write) {
    const rendered = renderContents(headings, entries.some(entry => entry.nested))
    lines.splice(range.start, range.end - range.start, ...rendered)
    fs.writeFileSync(file, lines.join('\n'))
    return []
  }
  return problems
}

function docsFiles() {
  return fs.readdirSync(DOCS_DIR)
    .filter(name => name.endsWith('.md') && name !== 'README.md')
    .sort()
    .map(name => path.join(DOCS_DIR, name))
}

function renderIndex(files) {
  const out = [
    '# Documentation index',
    '',
    'Every document in this folder and its sections. **Generated by `scripts/check-doc-contents.js`; edit the',
    'documents, not this file, then run `node scripts/check-doc-contents.js --write`.**',
    '',
    'This lists what is in each document. For which one to read for a given question, see *Documentation*',
    'in the [README](../README.md) and the list in [`AGENTS.md`](../AGENTS.md). Parked work has its own',
    'index in [`backlog/README.md`](backlog/README.md).',
    '',
  ]
  for (const file of files) {
    const name = path.basename(file)
    const { title, headings } = readHeadings(fs.readFileSync(file, 'utf8'))
    out.push(`## [${title || name}](${name})`, '')
    for (const heading of headings) {
      if (heading.level !== 2 || heading.text === CONTENTS_HEADING) continue
      out.push(`- [${heading.text}](${name}#${heading.anchor})`)
    }
    out.push('')
  }
  return out.join('\n')
}

function main() {
  const write = process.argv.includes('--write')
  const files = docsFiles()
  const documents = [...ROOT_DOCUMENTS.map(name => path.join(REPO_ROOT, name)), ...files]
  let failed = false

  for (const file of documents) {
    for (const problem of checkDocument(file, write)) {
      failed = true
      console.error(`${path.relative(REPO_ROOT, file)}: Contents ${problem}`)
    }
  }

  // After the documents, so an index written in the same run reflects any list just rewritten.
  const index = renderIndex(files)
  const current = fs.existsSync(INDEX_PATH) ? fs.readFileSync(INDEX_PATH, 'utf8') : null
  if (current !== index) {
    if (write) {
      fs.writeFileSync(INDEX_PATH, index)
    } else {
      failed = true
      console.error(`${path.relative(REPO_ROOT, INDEX_PATH)}: out of date with the headings in docs/`)
    }
  }

  if (failed) {
    console.error('\nRun `node scripts/check-doc-contents.js --write` to regenerate.')
    process.exit(1)
  }
  console.log(write ? 'Documentation contents and index written.' : 'Documentation contents and index are current.')
}

main()
