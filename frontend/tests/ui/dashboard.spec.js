import { expect, test } from '@playwright/test'

// With the demo's ~3 months of data the dashboard should render its charts and switch chart modes
// without crashing — empty-state can hide render bugs that only surface once there's real data.
//
// Navigate via the Dashboard nav link rather than goto('/'): the app's once-per-mount startup-route
// preference can redirect "/" elsewhere, and that preference is shared across parallel specs on the
// one demo DB. Clicking the link lands on the dashboard regardless.
test('dashboard renders and switches chart modes with demo data', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Expenses' })).toBeVisible()

  // Exercise the chart-mode controls against real data; the page must stay rendered.
  await page.getByRole('button', { name: 'Trends' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await page.getByRole('button', { name: 'Income' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
})

// The single-period trend pans by scrolling, and its hover card is PanningChartTooltip, placed against what
// can be seen rather than against the whole scrolled canvas. This is the in-page check of that wiring: the
// card appears for a hover near either end of a narrowed scroll area and stays inside it. Near the right end
// the hovered bar's centre — what Recharts anchors on — lies past the visible edge, which is how this check
// caught a flip that cleared only one edge.
//
// It does not reproduce the originally reported clipping on the demo data: the few months draw the plot at
// its minimum width (420px) in wide buckets, so Recharts' own flip at the canvas edge happens to land in view
// too, and this passes with Recharts' tooltip as well (checked). That contract is pinned in
// components/__tests__/PanningChartTooltip.test.jsx. The scroll area is narrowed directly because a window
// narrow enough to overflow the plot also overflows the page around it.
test('single-period trend tooltips stay inside the visible part of a narrowed scroll area', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await page.getByRole('button', { name: 'Single period' }).click()

  // Found by computed style: Chrome writes an element with both overflow axes set as the `overflow`
  // shorthand, so an attribute selector on `overflow-x` matches nothing. The innermost match (the last in
  // document order) is the trend's own scroll area; the page's content column also scrolls and holds it.
  const findScroller = `[...document.querySelectorAll('div')].filter(el => (
    getComputedStyle(el).overflowX === 'auto' && el.querySelector('.recharts-bar-rectangle')
  )).pop()`
  await expect.poll(() => page.evaluate(`!!(${findScroller})`)).toBe(true)
  const scroller = await page.evaluateHandle(findScroller)
  await scroller.evaluate(el => { el.style.maxWidth = '220px' })
  await expect.poll(() => scroller.evaluate(el => el.scrollWidth - el.clientWidth)).toBeGreaterThan(180)
  // The page answers the narrowing by re-centring the trend, and a tooltip gives way to any scroll. That
  // scroll has to land before the hover, and the overflow above is there before it does. The trend can
  // also be redrawn after its first paint (under load, its data was seen landing after the hover), so
  // wait for the plot's width and scroll to read the same twice running.
  let lastReading = null
  await expect.poll(async () => {
    const reading = await scroller.evaluate(el => `${el.scrollWidth}:${el.scrollLeft}`)
    const settled = reading === lastReading && !reading.endsWith(':0')
    lastReading = reading
    return settled
  }, { intervals: [250] }).toBe(true)
  await scroller.evaluate(el => el.scrollIntoView({ block: 'center' }))

  const area = await scroller.boundingBox()
  for (const x of [14, area.width - 14]) {
    await scroller.hover({ position: { x, y: area.height * 0.45 } })
    const card = page.locator('.recharts-default-tooltip').filter({ visible: true }).first()
    await expect(card).toBeVisible()
    const box = await card.boundingBox()
    const viewport = page.viewportSize()
    expect(box.x).toBeGreaterThanOrEqual(area.x - 1)
    expect(box.x + box.width).toBeLessThanOrEqual(area.x + area.width + 1)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
  }
})

// A refresh that brings back the same buckets must leave the pan where it was. The page reloads its totals
// on every ledger change, and re-centring on each reload moved the plot under the reader and dropped an
// open tooltip. The scroll area is narrowed as above so the demo's few months overflow it.
test('single-period trend keeps its pan through a refresh that changes nothing', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await page.getByRole('button', { name: 'Single period' }).click()

  const findScroller = `[...document.querySelectorAll('div')].filter(el => (
    getComputedStyle(el).overflowX === 'auto' && el.querySelector('.recharts-bar-rectangle')
  )).pop()`
  await expect.poll(() => page.evaluate(`!!(${findScroller})`)).toBe(true)
  const scroller = await page.evaluateHandle(findScroller)
  await scroller.evaluate(el => { el.style.maxWidth = '220px' })
  await expect.poll(() => scroller.evaluate(el => el.scrollLeft)).toBeGreaterThan(0)

  // Panned to a spot that centres no bucket, so a re-centre on any of them would move it.
  await scroller.evaluate(el => { el.scrollLeft = 90 })
  const reloaded = page.waitForResponse(response => response.url().includes('/summary/monthly-trend'))
  await page.evaluate(() => window.dispatchEvent(new Event('luma:transactions-changed')))
  await reloaded
  // The reload lands a render after its response; the bars are redrawn from it either way.
  await page.waitForTimeout(500)
  expect(await scroller.evaluate(el => el.scrollLeft)).toBe(90)
})

// The Trends tab's monthly-averages table drills like the rest of the page: a group row opens that
// group's categories, and a category's ↗ opens the transactions behind its figure, in a report scoped to
// the category and the table's window.
test('trends averages drill from a group to its categories and open a category report', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await page.getByRole('button', { name: 'Trends' }).click()
  // The frame is a saved preference on the shared demo database, which the spec above leaves on Income.
  await page.getByRole('button', { name: 'Expenses' }).click()

  const groupRow = page.getByRole('button', { name: /^Show the categories in / }).first()
  await expect(groupRow).toBeVisible()
  const groupName = (await groupRow.getAttribute('aria-label')).replace('Show the categories in ', '')

  // The group picker offers what the table lists at "All groups" — the groups with transactions in the
  // window on screen — alphabetically. It once listed the groups with spending in the current month.
  const tableGroups = (await page.getByRole('button', { name: /^Show the categories in / }).evaluateAll(
    rows => rows.map(row => row.getAttribute('aria-label').replace('Show the categories in ', '')),
  ))
  const groupPicker = page.locator('select').filter({ has: page.locator('option', { hasText: 'All groups' }) })
  await expect.poll(async () => (await groupPicker.locator('option').allTextContents()).slice(1))
    .toEqual([...tableGroups].sort((a, b) => a.localeCompare(b)))

  // The drill reloads every chart on the tab. The table is clicked at the bottom of a long page, so the
  // reader has to stay there while that happens — swapping the tab out for a loading state collapses the
  // page and lands them back at the top. The scroll may still move by exactly as much as a shorter page
  // forces (fewer categories than groups, read from the bottom), and no further; the viewport position
  // of the table cannot express that, since that clamp moves it too.
  const averagesTitle = page.getByText(/^Monthly averages/).first()
  const scrollState = () => averagesTitle.evaluate(el => {
    let node = el.parentElement
    while (node && !/(auto|scroll)/.test(getComputedStyle(node).overflowY)) node = node.parentElement
    const scroller = node || document.scrollingElement
    return { top: scroller.scrollTop, max: scroller.scrollHeight - scroller.clientHeight }
  })
  await page.getByRole('button', { name: /^Show the categories in / }).last().scrollIntoViewIfNeeded()
  const scrollBefore = await scrollState()
  expect(scrollBefore.top).toBeGreaterThan(0)
  await groupRow.click()

  // Drilled: the table names the group and offers the way back, and its rows are categories.
  const back = page.getByRole('button', { name: 'All groups', exact: true })
  await expect(back).toBeVisible()
  await expect(page.getByText(`Monthly averages · ${groupName}`)).toBeVisible()
  const reportArrow = page.getByRole('button', { name: /^Open the transactions behind / }).first()
  await expect(reportArrow).toBeVisible()
  const scrollAfter = await scrollState()
  expect(Math.abs(scrollAfter.top - Math.min(scrollBefore.top, scrollAfter.max))).toBeLessThan(2)

  // A group's charts run at a smaller scale than the whole ledger's, which is where a value axis that
  // rounds to whole thousands repeats itself ("$0k, $1k, $1k, $2k"). Every Trends axis has to tell its
  // own ticks apart.
  const axisLabels = await page.evaluate(() => [...document.querySelectorAll('.recharts-yAxis-tick-labels')]
    .map(axis => [...axis.querySelectorAll('text')].map(tick => tick.textContent)))
  expect(axisLabels.flat().length).toBeGreaterThan(0)
  expect(axisLabels.filter(labels => new Set(labels).size !== labels.length)).toEqual([])
  const categoryName = (await reportArrow.getAttribute('aria-label')).replace('Open the transactions behind ', '')
  await reportArrow.click()
  const reportTitle = page.getByText(new RegExp(`^${categoryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · (Last 12 months|\\d{4}) · Spending$`))
  await expect(reportTitle).toBeVisible()

  // The report sits over the table, so close it before stepping back up to the groups.
  await page.keyboard.press('Escape')
  await expect(reportTitle).toBeHidden()
  await back.click()
  await expect(page.getByRole('button', { name: /^Show the categories in / }).first()).toBeVisible()
})

// A drill switches the tab when the group's figures arrive, not before. Switching first drew the group's
// title and its categories' report arrows over the rows still on screen — the groups — where a click
// opened a "category" report for a group. The group's series is held here so that window is certain to
// be observed instead of depending on timing.
test('a trends drill waits for the group figures before switching the tab', async ({ page }) => {
  let release
  const held = new Promise(resolve => { release = resolve })
  await page.route(/\/api\/transactions\/summary\/monthly-by-group\?.*group_id=/, async route => {
    await held
    await route.continue()
  })
  try {
    await page.goto('/')
    await page.getByRole('link', { name: 'Dashboard' }).click()
    await page.getByRole('button', { name: 'Trends' }).click()
    await page.getByRole('button', { name: 'Expenses' }).click()
    const groupRow = page.getByRole('button', { name: /^Show the categories in / }).first()
    await expect(groupRow).toBeVisible()
    const groupName = (await groupRow.getAttribute('aria-label')).replace('Show the categories in ', '')
    await groupRow.click()

    // The picker answers the choice at once; the table and title still describe the groups.
    const groupPicker = page.locator('select').filter({ has: page.locator('option', { hasText: 'All groups' }) })
    await expect(groupPicker.locator('option:checked')).toHaveText(groupName)
    await expect(page.getByText('Monthly averages by group')).toBeVisible()
    await expect(page.getByRole('button', { name: /^Open the transactions behind / })).toHaveCount(0)

    release()
    await expect(page.getByText(`Monthly averages · ${groupName}`)).toBeVisible()
    await expect(page.getByRole('button', { name: /^Open the transactions behind / }).first()).toBeVisible()
  } finally {
    release()
    await page.unroute(/\/api\/transactions\/summary\/monthly-by-group/)
  }
})

// A tag report's right-click / ⋯ menu edits it in place: the unsaved custom report can have its tags
// changed and be saved under a name, and a saved one can have its tags changed without losing its
// identity. The builder has to open on the report's current tags each time, or "edit" is a rebuild.
// The catalog is shared state on the one demo database, so the report gets a unique name and is
// deleted at the end — which also puts the breakdown back on group for the other specs.
test('tag report menu edits tags and saves the unsaved report under a name', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await page.getByRole('button', { name: 'Single period' }).click()
  await page.getByRole('button', { name: 'Expenses' }).click()

  const picker = page.getByLabel('Choose dashboard spending breakdown')
  const selected = picker.locator('option:checked')
  const discretionary = page.getByRole('checkbox', { name: 'Discretionary' })
  const essential = page.getByRole('checkbox', { name: 'Essential Expenses' })
  const menuItems = page.getByRole('menuitem')
  const openHeaderMenu = () => page.getByText('Spending by', { exact: true }).click({ button: 'right' })

  await picker.selectOption({ label: '+ Tag report' })
  await discretionary.check()
  await page.getByRole('button', { name: 'Display', exact: true }).click()
  await expect(selected).toHaveText('Custom (unsaved)')

  // The unsaved report: nothing to rename or delete, but its tags can change and it can be kept.
  await openHeaderMenu()
  await expect(menuItems).toHaveText(['Edit tags…', 'Save as…'])
  await page.getByRole('menuitem', { name: 'Edit tags…' }).click()
  await expect(discretionary).toBeChecked()
  await essential.check()
  await page.getByRole('button', { name: 'Display', exact: true }).click()
  await expect(selected).toHaveText('Custom (unsaved)')

  const name = `Spec tag report ${Date.now().toString(36)}`
  await openHeaderMenu()
  await page.getByRole('menuitem', { name: 'Save as…' }).click()
  await page.getByLabel('Tag report name').fill(name)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(selected).toHaveText(name)
  await expect(picker.locator('option', { hasText: 'Custom (unsaved)' })).toHaveCount(0)

  // The saved report: Rename stays beside Edit tags…, which opens on both tags and saves over the report.
  const manage = page.getByTitle('Manage this tag report')
  await manage.click()
  await expect(menuItems).toHaveText(['Rename', 'Edit tags…', 'Delete'])
  await page.getByRole('menuitem', { name: 'Edit tags…' }).click()
  await expect(discretionary).toBeChecked()
  await expect(essential).toBeChecked()
  const save = page.getByRole('button', { name: 'Save', exact: true })
  await expect(save).toBeDisabled()
  await essential.uncheck()
  await save.click()
  await expect(selected).toHaveText(name)

  // Persisted, not just held in the page: after a reload the builder opens on the edited set. A load at `/`
  // lands on the remembered startup route, which the specs running beside this one keep moving, so return to
  // the Dashboard by its link rather than trusting where the reload put the page.
  await page.reload()
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await expect(selected).toHaveText(name)
  await manage.click()
  await page.getByRole('menuitem', { name: 'Edit tags…' }).click()
  await expect(discretionary).toBeChecked()
  await expect(essential).not.toBeChecked()
  await page.getByRole('button', { name: 'Cancel' }).click()

  await manage.click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(picker.locator('option', { hasText: name })).toHaveCount(0)
})

// A tag edit has to move the report it was made from.
//
// The whole point of drilling a wedge is that the panel and the pie behind it are the same population,
// and a tag is the dimension the report buckets by — so removing one from a drilled transaction changes
// the bucket it was counted in. Two things had to be true for that to show, and neither was: the write
// has to reach the invalidation seam (it was calling `api.updateTransactionTag` directly, so nothing
// re-queried an aggregate), and the open panel has to re-read its wedge from the refreshed figures
// rather than the snapshot it opened with. The row itself stays put throughout — an edited transaction
// lingers where it was found — so the count is what moves, and it is the thing to assert.
//
// Both directions, because the tag is restored at the end: the demo database is shared with the specs
// running beside this one, and a blocked inherited tag would otherwise outlive the run.
test('removing a tag from a drilled transaction moves the report behind it', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await page.getByRole('button', { name: 'Single period' }).click()
  await page.getByRole('button', { name: 'Expenses' }).click()

  const picker = page.getByLabel('Choose dashboard spending breakdown')
  await picker.selectOption({ label: '+ Tag report' })
  await page.getByRole('checkbox', { name: 'Discretionary' }).check()
  await page.getByRole('button', { name: 'Display', exact: true }).click()

  // The wedge for the one selected tag, opened from the breakdown list beside the pie. The panel's
  // subtitle is the server's bucket for that wedge — the figure the pie is drawn from — and is the only
  // "N transactions" on screen, since the page behind it is at the breakdown level with no rows of its own.
  await page.getByTitle('Discretionary', { exact: true }).click()
  const count = page.getByText(/· \d+ transactions · /)
  const before = Number((await count.textContent()).match(/(\d+) transactions/)[1])
  expect(before).toBeGreaterThan(1)

  // The demo seeds Discretionary on Dining Out, so a Corner Bistro row carries it as an inherited chip and
  // unchecking it writes the per-transaction block. Named rather than taken as the first chip, because
  // for the moment it is blocked the row really has lost the tag, and `transactions.spec.js` reads
  // Discretionary off another Dining Out row while this runs beside it.
  const inheritedChip = page.getByRole('button', { name: /^Discretionary \(inherited from/ })
  await page.locator('div').filter({ hasText: 'The Corner Bistro' }).filter({ has: inheritedChip }).last()
    .getByRole('button', { name: /^Discretionary \(inherited from/ }).click()
  // `click` rather than `uncheck`/`check`: the box is driven by the row's tags as the write answers, so
  // its state does not change in the same tick as the click and Playwright's own state check races it.
  const choice = page.getByRole('checkbox', { name: /^Discretionary/ })
  await choice.click()
  await expect(choice).not.toBeChecked()
  await expect(count).toContainText(`${before - 1} transactions`)

  await choice.click()
  await expect(choice).toBeChecked()
  await expect(count).toContainText(`${before} transactions`)

  // Leave the breakdown where the other specs expect it: the report here was never saved, but the
  // selection is a persisted preference.
  await page.getByRole('button', { name: 'Close', exact: true }).last().click()
  await picker.selectOption({ label: 'group' })
})

// Instrumentation for `docs/transient-failures.md` entry 3: a click on a same-span bar that did not
// navigate. It records, on the page's own clock, every dashboard summary request and when it settled, and
// for each mousedown, mouseup and click what was under the pointer, whether the trend's bars were still
// the ones the test measured, the plot's scroll offset, and which tooltip recharts was showing. A click
// recharts reports nothing active for is ignored by the chart, so the tooltip at the click is the piece
// that separates "the click arrived before the hover" from "the chart was redrawn under it". Test-side
// only, through `addInitScript`; times are `performance.now()` because this host's wall clock steps
// backwards (entry 1).
async function instrumentTrendClick(page) {
  await page.addInitScript(() => {
    window.__trendLog = []
    const log = (event, detail) => window.__trendLog.push({ at: performance.now(), event, ...detail })
    window.__trendMark = (event, detail) => log(event, detail)
    const realFetch = window.fetch
    window.fetch = function instrumentedFetch(...args) {
      const url = String(args[0]?.url || args[0] || '')
      if (!url.includes('/summary/')) return realFetch.apply(this, args)
      const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
      log('request', { path })
      return realFetch.apply(this, args).then(response => {
        log('response', { path, status: response.status })
        return response
      }, err => {
        log('request failed', { path, error: String(err) })
        throw err
      })
    }
    const chartState = () => {
      const bars = document.querySelectorAll('.recharts-bar-rectangle')
      const scroller = [...document.querySelectorAll('div')].filter(el => (
        getComputedStyle(el).overflowX === 'auto' && el.querySelector('.recharts-bar-rectangle')
      )).pop()
      const tooltips = [...document.querySelectorAll('.recharts-tooltip-wrapper')]
        .filter(el => getComputedStyle(el).visibility !== 'hidden')
        .map(el => el.textContent.trim().replace(/\s+/g, ' '))
      return {
        bars: bars.length,
        // The node itself is kept off to the side: whether the bar measured before the click is still in
        // the document at the click says whether the chart was redrawn in between.
        measuredBarAttached: window.__trendMeasuredBar ? window.__trendMeasuredBar.isConnected : null,
        scrollLeft: scroller ? scroller.scrollLeft : null,
        tooltip: tooltips.join(' | ') || '(none showing)',
      }
    }
    window.__trendChartState = chartState
    for (const type of ['mousedown', 'mouseup', 'click']) {
      document.addEventListener(type, event => {
        const target = event.target
        log(type, {
          x: Math.round(event.clientX),
          y: Math.round(event.clientY),
          target: `${target?.tagName || '?'}${target?.getAttribute?.('class') ? `.${target.getAttribute('class')}` : ''}`,
          inChart: Boolean(target?.closest?.('.recharts-wrapper')),
          ...chartState(),
        })
      }, true)
    }
  })
}

// The log from the switch to same span onward, as lines timed against the bar's mousedown, so "before"
// and "after" are read rather than inferred.
async function trendClickReport(page) {
  const { all, now } = await page.evaluate(() => ({
    all: (window.__trendLog || []).map(entry => ({ ...entry })),
    now: window.__trendChartState ? window.__trendChartState() : null,
  }))
  const entries = all.slice(Math.max(0, all.findIndex(entry => entry.event === 'same span chosen')))
  const measured = entries.findIndex(entry => entry.event === 'bar measured')
  const down = entries.slice(measured).find(entry => entry.event === 'mousedown')?.at
  const at = ms => (down == null ? `${Math.round(ms)}ms` : `${ms < down ? '-' : '+'}${Math.round(Math.abs(ms - down))}ms`)
  const lines = entries.map(({ at: time, event, ...detail }) => `  ${at(time)} ${event} ${JSON.stringify(detail)}`)
  return [
    `Chart now: ${JSON.stringify(now)}`,
    'Summary requests and pointer events since same span was chosen (times relative to the bar\'s mousedown):',
    ...(lines.length ? lines : ['  (nothing recorded)']),
  ].join('\n')
}

// The single-period trend's grain chooser stays on screen while the chart navigates the period. A bar
// click once replaced it with the back-step alone, leaving no way into a selected year's months; and a
// to-date selection could only be compared against earlier periods rounded to whole months. This walks
// the reported path: a to-date pick, its exact same-span comparison, a bar click and the step back
// keeping that choice, and a FilterBar pick keeping it too. Month to date rather than year to date, because
// the demo ledger's spending sits in one year but several months.
test('single-period trend keeps its grain chooser through bar clicks and compares exact spans', async ({ page }) => {
  // Late in a month, Month to date's same span is a whole month for the clicked bar (the 1st–30th of
  // September), which is a calendar month, so the chooser rightly shows Monthly there. Mid-month, no bar is.
  const real = new Date()
  const now = new Date(real.getFullYear(), real.getMonth(), Math.min(real.getDate(), 15), 12)
  await page.clock.setSystemTime(now)
  await instrumentTrendClick(page)
  await page.goto('/')
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await page.getByRole('button', { name: 'Single period' }).click()
  await page.getByRole('button', { name: 'Expenses' }).click()

  const grain = page.getByRole('combobox', { name: 'Trend bucket size' })
  const datePicker = page.getByRole('button', { name: /^📅/ })
  const pickPreset = async label => {
    await datePicker.click()
    await page.getByText(label, { exact: true }).click()
  }
  // The trend is two charts, the fixed axis column first and the panning plot after it, each drawing one
  // rectangle per bucket; the plot's are the second half.
  const firstPlotBar = async () => {
    const bars = page.locator('.recharts-bar-rectangle')
    await expect.poll(() => bars.count()).toBeGreaterThan(2)
    return bars.nth((await bars.count()) / 2)
  }

  await pickPreset('Year to date')
  await expect(grain).toHaveValue('year')
  await expect(grain.locator('option')).toHaveText(['Monthly', 'Quarterly', 'Yearly', 'Same span each year'])

  await pickPreset('Month to date')
  await expect(grain).toHaveValue('month')
  // Same span asks for day-precise totals: the 1st through today's date in each month, ending with this one.
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const today = `${thisMonth}-${String(now.getDate()).padStart(2, '0')}`
  const spanRequest = page.waitForRequest(request => request.url().includes('/summary/range-trend'))
  const spanResponse = page.waitForResponse(response => response.url().includes('/summary/range-trend'))
  // A bar from the monthly chart, kept to see the same-span chart replace it (below).
  const monthlyBar = await (await firstPlotBar()).elementHandle()
  await page.evaluate(() => window.__trendMark('same span chosen', window.__trendChartState()))
  await grain.selectOption('span')
  const ranges = new URL((await spanRequest).url()).searchParams.get('ranges').split(',')
  expect(ranges.at(-1)).toBe(`${thisMonth}-01:${today}`)
  expect(ranges.every(range => range.slice(8, 10) === '01' && Number(range.slice(-2)) <= now.getDate())).toBe(true)
  // The response redraws the chart with new bars, so a bar found before then is gone by the click
  // (`docs/transient-failures.md` entry 3). Wait for the monthly bar to leave before taking one.
  await spanResponse
  await expect.poll(() => monthlyBar.evaluate(node => node.isConnected)).toBe(false)

  // A click in a bar's column selects that exact span, keeps the chooser and its pick, and the back-step
  // keeps it too. The click lands at the top of the plot rather than on the bar: the whole column is the
  // target, so a bar too short to hit is still selectable.
  const bar = await firstPlotBar()
  await bar.scrollIntoViewIfNeeded()
  const barBox = await bar.boundingBox()
  const plotBox = await bar.locator('xpath=ancestor::*[local-name()="svg"][1]').boundingBox()
  await bar.evaluate(node => {
    window.__trendMeasuredBar = node
    window.__trendMark('bar measured', window.__trendChartState())
  })
  await page.mouse.click(barBox.x + barBox.width / 2, plotBox.y + 12)
  const back = page.getByRole('button', { name: /^← Back to Month to date/ })
  try {
    await expect(back).toBeVisible()
  } catch (err) {
    const report = [
      err.message,
      '',
      'Failed: the bar click did not navigate (transient-failures.md, entry 3)',
      `Clicked at (${Math.round(barBox.x + barBox.width / 2)}, ${Math.round(plotBox.y + 12)}); chooser now ${
        await grain.inputValue()}; date chip now "${(await datePicker.textContent())?.trim()}"`,
      await trendClickReport(page),
    ].join('\n')
    const failure = new Error(report)
    // As in needs-review-marker.spec.js: a report line Playwright reads as a stack frame would be printed
    // twice, so the stack is pinned to the message.
    failure.stack = report
    throw failure
  }
  await expect(grain).toHaveValue('span')
  await back.click()
  await expect(datePicker).toHaveText(/Month to date/)
  await expect(grain).toHaveValue('span')

  // A pick holds through a FilterBar pick too, where the selection's default would differ: Last month
  // opens monthly.
  await grain.selectOption('year')
  await pickPreset('Last month')
  await expect(grain).toHaveValue('year')
  await expect(grain.locator('option')).toHaveText(['Monthly', 'Quarterly', 'Yearly'])
})

// The amount filter lives in the shared FilterBar: set on the Dashboard, it narrows the summary requests
// and is still in force on the Transactions page. The figures it produces are the backend's to prove
// (backend/tests/test_dashboard_filter_reconciliation.py); this checks that the control reaches both pages.
test('the filter bar amount filter narrows the dashboard and carries over to transactions', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()

  // Anchored on the icon: the ledger's Amount column header is also a button named Amount.
  const amountButton = page.getByRole('button', { name: /^💲 Amount/ })
  await amountButton.click()
  await page.getByRole('button', { name: 'Debits', exact: true }).click()
  const summaryRequest = page.waitForRequest(request => (
    request.url().includes('/transactions/summary/') && request.url().includes('direction=debit')
  ))
  await page.getByRole('button', { name: 'Apply' }).click()
  await summaryRequest
  await expect(amountButton).toContainText('debit')

  const ledgerRequest = page.waitForRequest(request => (
    /\/api\/transactions\?/.test(request.url()) && request.url().includes('direction=debit')
  ))
  await page.getByRole('link', { name: 'Transactions' }).click()
  await ledgerRequest
  await expect(amountButton).toContainText('debit')
})
