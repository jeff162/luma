#!/usr/bin/env node

// Runs the browser lane with ten sessions on one backend and reports how the backend held up.
//
// The everyday lane (`npm run ui:test`) runs three at a time, because more than that makes requests slow
// each other down until pages miss their deadlines. This run deliberately goes back to ten so that kind
// of slowdown can be seen and measured: what it is, why it happens and what the figures below should look
// like are in docs/scale-and-limits.md → "Many sessions on one server". Run it before a release, and after
// a change to anything every page asks for (the Tasks poll above all) or to how the backend uses the
// database.
//
// It is a measurement, not a pass/fail check. Specs may fail along the way and the run carries on; what
// matters is the report printed at the end. The whole run is kept in data/stress-logs/.

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const SESSIONS = 10
const repoRoot = path.resolve(__dirname, '..')
const frontendDir = path.join(repoRoot, 'frontend')
const logDir = path.join(repoRoot, 'data', 'stress-logs')
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const logPath = path.join(logDir, `stress-${stamp}.log`)

fs.mkdirSync(logDir, { recursive: true })
const log = fs.createWriteStream(logPath)

const child = spawn(
  'npx',
  ['playwright', 'test', '--config=playwright.config.js', '--project', 'app', '--project', 'import',
    '--project', 'marketplace', `--workers=${SESSIONS}`],
  {
    cwd: frontendDir,
    env: { ...process.env, TRACE_DB_CONTENTION: '1', PLAYWRIGHT_APP_WORKERS: String(SESSIONS) },
    shell: process.platform === 'win32',
  },
)
child.stdout.pipe(log)
child.stderr.pipe(log)
console.log(`Running the browser lane with ${SESSIONS} sessions; the full output goes to ${path.relative(repoRoot, logPath)}`)

child.on('close', () => {
  log.end(() => {
    console.log(report(fs.readFileSync(logPath, 'utf8')))
    console.log(`\nFull output: ${path.relative(repoRoot, logPath)}`)
  })
})

function report(text) {
  const lines = text.split('\n')
  const out = []

  const count = (re) => { const m = text.match(re); return m ? Number(m[1]) : 0 }
  const failedSpecs = [...new Set(lines.filter(l => /^\s+✘/.test(l)).map(l => l.replace(/^\s+✘\s+\d+\s+/, '').replace(/\s+\(\d.*\)$/, '').trim()))]
  out.push('Specs')
  out.push(`  passed ${count(/^\s+(\d+) passed/m)}, failed ${count(/^\s+(\d+) failed/m)}, did not run ${count(/^\s+(\d+) did not run/m)}`)
  for (const spec of failedSpecs) out.push(`  failed: ${spec}`)

  const locked = lines.filter(l => l.includes('database is locked')).length
  out.push('')
  out.push('Database lock')
  out.push(`  "database is locked" errors: ${locked}${locked ? '  <- a write waited out the whole busy timeout' : ''}`)
  const holds = lines.filter(l => l.includes('[db-hold]')).map(l => ({
    span: Number(l.match(/span ([\d.]+)s/)[1]),
    slowest: Number(l.match(/slowest-stmt ([\d.]+)s/)[1]),
    first: (l.match(/first: (.*?) \| slowest:/) || [])[1] || '',
  }))
  const longestWait = holds.reduce((best, h) => (h.slowest > (best?.slowest ?? -1) ? h : best), null)
  const longestHold = holds.reduce((best, h) => (h.span > (best?.span ?? -1) ? h : best), null)
  out.push(`  longest single write (mostly time waiting for the lock): ${longestWait ? `${longestWait.slowest.toFixed(2)}s` : 'under 1s'}`)
  if (longestHold) out.push(`  longest time the lock was held: ${longestHold.span.toFixed(2)}s, starting with ${longestHold.first.slice(0, 90)}`)

  const requests = lines.filter(l => l.includes('[slow-request]')).map(l => {
    const m = l.match(/\[slow-request\] ([\d.]+)s (\S+) (\S+)/)
    return { seconds: Number(m[1]), name: `${m[2]} ${m[3].replace(/\/[0-9a-f-]{32,36}(?=\/|$)/g, '/:id')}` }
  })
  const byEndpoint = new Map()
  for (const r of requests) {
    const e = byEndpoint.get(r.name) || { n: 0, total: 0, max: 0 }
    e.n += 1; e.total += r.seconds; e.max = Math.max(e.max, r.seconds)
    byEndpoint.set(r.name, e)
  }
  out.push('')
  out.push('Requests that took a second or more')
  out.push(`  ${requests.length} requests, ${requests.reduce((s, r) => s + r.seconds, 0).toFixed(0)}s in total`)
  for (const [name, e] of [...byEndpoint].sort((a, b) => b[1].max - a[1].max).slice(0, 10)) {
    out.push(`  ${e.max.toFixed(1).padStart(5)}s slowest  ${String(e.n).padStart(3)}x  ${name}`)
  }

  const blocks = lines.filter(l => l.includes('[db-block]')).map(l => ({
    span: Number(l.match(/span ([\d.]+)s/)[1]),
    sql: Number(l.match(/sql ([\d.]+)s/)[1]),
  })).sort((a, b) => b.span - a.span)
  if (blocks.length) {
    out.push('')
    out.push('Slowest database connections: time open, and the part spent in database calls')
    for (const b of blocks.slice(0, 5)) out.push(`  ${b.span.toFixed(1).padStart(5)}s open, ${b.sql.toFixed(1)}s in database calls`)
  }

  out.push('')
  out.push('Compare with the figures in docs/scale-and-limits.md → "Many sessions on one server".')
  return out.join('\n')
}
