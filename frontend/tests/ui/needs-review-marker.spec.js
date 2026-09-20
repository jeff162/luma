import { expect, test } from '@playwright/test'

// Clicking a row's R marker marks it reviewed, and the list does not change under the click — even with
// the ledger filtered to Needs review, where the reviewed row no longer matches. That is what keeps
// clicking down a list safe, and it only holds in the real page: the unit tests pin the row patch, not
// the ledger that decides whether to re-query. Refresh is the one thing that drops the row.
//
// The demo data is shared across the phase, so the test ends by undoing its own review.
//
// **Every post-click assertion is instrumented** (see `docs/transient-failures.md` → the intermittent one
// here). Two shapes have been seen, and they are opposites: the marker coming back (a write that did not
// land, or a row patch overwritten by a list response already in flight) and the count *falling* (a list
// response that arrived after the write, when the premise is that nothing re-queries at all). Telling
// them apart needs three things a bare assertion failure does not carry — the row's state on the server,
// every transactions request with what it returned, and **what issued each one** — so all four assertions
// report them rather than only the first. Losing the diagnostics because the failure landed one line
// lower than the instrumented assertion has already happened once.

// Records every `/api/transactions` fetch the page makes: when it was issued, when it settled, what came
// back, and the JS stack that called it. Test-side only (`addInitScript` wraps the page's own `fetch`),
// so nothing production-side changes and no debug code ships.
//
// Times are `performance.now()`, deliberately: they are monotonic, and this host's wall clock is known to
// step backwards by a second or two mid-run (see the register's first entry), which would scramble any
// ordering taken from `Date.now()` — in a race whose whole question is ordering.
async function instrumentTransactionFetches(page) {
  await page.addInitScript(() => {
    window.__txnFetchLog = []
    const realFetch = window.fetch
    window.fetch = function instrumentedFetch(...args) {
      const url = String(args[0]?.url || args[0] || '')
      if (!url.includes('/api/transactions')) return realFetch.apply(this, args)
      const entry = {
        url: url.replace(/^https?:\/\/[^/]+/, ''),
        issuedAt: performance.now(),
        // The frame that issued the call is what tells a React effect apart from an event handler apart
        // from a late timer — the difference between "something re-queried" and "which thing did".
        // The leading "at " of each frame is stripped: Playwright's error formatter treats a line
        // starting with it as its own stack and re-prints the message, burying the log it was given.
        stack: (new Error().stack || '').split('\n').slice(2, 7)
          .map(l => l.trim().replace(/^at /, '')).join(' ⏎ '),
      }
      window.__txnFetchLog.push(entry)
      return realFetch.apply(this, args).then(response => {
        entry.settledAt = performance.now()
        entry.status = response.status
        // Read the clone off to the side rather than awaiting it here: blocking the return would delay
        // the page's own handling and shift the very timing this is trying to observe.
        response.clone().json().then(body => {
          entry.total = body?.total
          entry.rows = Array.isArray(body?.transactions) ? body.transactions.length : null
          entry.needingReview = Array.isArray(body?.transactions)
            ? body.transactions.filter(txn => txn.needs_review).length
            : null
        }).catch(() => { entry.total = '(body unreadable)' })
        return response
      }, err => {
        entry.settledAt = performance.now()
        entry.error = String(err)
        throw err
      })
    }
  })
}

// The log as lines, each timed against the click so "before" and "after" are read rather than inferred.
async function fetchLog(page) {
  const entries = await page.evaluate(() => ({
    clickedAt: window.__txnClickAt ?? null,
    log: (window.__txnFetchLog || []).map(e => ({ ...e })),
  }))
  if (!entries.log.length) return '  (the page made no transactions requests at all)'
  const at = ms => (ms == null ? '?' : `${entries.clickedAt == null ? '' : ms < entries.clickedAt ? '-' : '+'}${
    Math.round(Math.abs(ms - (entries.clickedAt ?? 0)))}ms`)
  return entries.log.map(e => [
    `  ${at(e.issuedAt)} issued → ${at(e.settledAt)} settled  ${e.url} → ${e.status ?? e.error ?? 'pending'}`,
    `      total=${e.total ?? '?'} rows=${e.rows ?? '?'} needingReview=${e.needingReview ?? '?'}`,
    `      issued by: ${e.stack || '(no stack)'}`,
  ].join('\n')).join('\n')
}

test('marking a row reviewed from its marker leaves the filtered list as it was, and undo restores it', async ({ page, request }) => {
  await instrumentTransactionFetches(page)

  await page.goto('/transactions?only=needs-review')
  await expect(page.getByRole('button', { name: '✕ Needs review' })).toBeVisible()

  const countLabel = page.locator('text=/^\\d+ transactions?$/')
  await expect(countLabel).toBeVisible()
  await expect(countLabel).not.toHaveText('0 transactions')
  const countText = await countLabel.textContent()

  const markers = page.getByRole('button', { name: 'Needs review — mark reviewed' })
  await expect(markers.first()).toBeVisible()
  const before = await markers.count()

  await markers.first().click()
  // Stamped in the page's own clock, so every logged request sorts against the click on one timebase.
  await page.evaluate(() => { window.__txnClickAt = performance.now() })
  await expect(page.getByText('Marked reviewed')).toBeVisible()
  // Which row was clicked, taken from the confirmation the app itself wrote (“<payee>” no longer needs
  // review), so its state can be read back from the server if the count disagrees.
  const clickedPayee = (await page.getByText(/no longer needs review/).textContent() || '')
    .replace(/^[^“]*“/, '').replace(/”.*$/, '')

  // Every assertion from here reports the same three facts on failure — the count label reads
  // `data.total` straight off the last list response, so a count that moves is a response that arrived,
  // and the log says which one and what called it.
  const diagnose = async (err, when) => {
    const report = [
      err.message,
      '',
      `Failed: ${when}`,
      `Clicked row: ${clickedPayee}`,
      // needs_review = 0 means the write landed and the page lost it; 1 means it never landed.
      `Server state after the click: ${await serverState(request, clickedPayee)}`,
      'Transactions requests (times relative to the click):',
      await fetchLog(page),
    ].join('\n')
    const failure = new Error(report)
    // The report's own lines carry `file.js:line:col`, which Playwright's reporter reads as stack frames
    // and re-prints below the message. Pinning `stack` to the message leaves the report printed once; the
    // spec line is already named by the assertion that threw.
    failure.stack = report
    return failure
  }

  // The row's marker is gone, but the row and the count stay put — no re-query happened.
  try {
    await expect(markers).toHaveCount(before - 1)
  } catch (err) { throw await diagnose(err, 'the marker did not clear') }
  try {
    await expect(countLabel).toHaveText(countText)
  } catch (err) { throw await diagnose(err, 'the row left the list under the click') }

  await page.getByRole('button', { name: 'Undo' }).click()
  try {
    await expect(markers).toHaveCount(before)
  } catch (err) { throw await diagnose(err, 'undo did not restore the marker') }
  try {
    await expect(countLabel).toHaveText(countText)
  } catch (err) { throw await diagnose(err, 'undo did not restore the count') }
})

// What the ledger holds for the clicked row, read straight from the API so it cannot be the page's own
// stale copy. Failure to read is reported rather than thrown — this runs while a test is already
// failing, and losing the original assertion to a second error would be the worse outcome.
async function serverState(request, payee) {
  try {
    const response = await request.get(
      `/api/transactions?quick_filter=${encodeURIComponent(payee || '')}&limit=5`)
    const body = await response.json()
    return JSON.stringify((body.transactions || []).map(txn => ({
      id: txn.id, payee: txn.merchant_name || txn.display_name, needs_review: txn.needs_review,
    })))
  } catch (err) {
    return `could not be read (${err.message})`
  }
}
