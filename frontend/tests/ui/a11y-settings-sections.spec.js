import { test, expect } from '@playwright/test'

// The page shows one section at a time, picked from a list down the left, so every section has to be
// opened in turn for its controls to be on screen.
const SECTIONED_PAGES = [
  ['/settings', 'Settings sections'],
]
// Sections opened from the title row rather than the list, reached by their link instead.
const HEADER_SECTIONS = ['/settings?section=about']

function unlabeledControls(page) {
  return page.evaluate(() => {
    function textFromNode(node) {
      return (node?.textContent || '').replace(/\s+/g, ' ').trim()
    }

    function labelledByText(el) {
      const ids = (el.getAttribute('aria-labelledby') || '')
        .split(/\s+/)
        .map(id => id.trim())
        .filter(Boolean)
      return ids
        .map(id => textFromNode(document.getElementById(id)))
        .filter(Boolean)
        .join(' ')
        .trim()
    }

    function labelText(el) {
      if (el.labels?.length) {
        return Array.from(el.labels)
          .map(label => textFromNode(label))
          .filter(Boolean)
          .join(' ')
          .trim()
      }
      const parentLabel = el.closest('label')
      return parentLabel ? textFromNode(parentLabel) : ''
    }

    function summary(el) {
      const attrs = []
      if (el.id) attrs.push(`#${el.id}`)
      if (el.name) attrs.push(`[name="${el.name}"]`)
      if (el.placeholder) attrs.push(`[placeholder="${el.placeholder}"]`)
      const nearby = el.closest('[role="dialog"], form, section, article, aside, main, div')
      const nearbyText = textFromNode(nearby).slice(0, 160)
      return `${el.tagName.toLowerCase()}${attrs.length ? ` ${attrs.join(' ')}` : ''}${nearbyText ? ` :: ${nearbyText}` : ''}`
    }

    return Array.from(document.querySelectorAll('input, select, textarea'))
      .filter(el => {
        if (!(el instanceof HTMLElement)) return false
        if (el.tagName === 'INPUT' && el.type === 'hidden') return false
        if (el.disabled) return false
        const style = window.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden') return false
        const rect = el.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      })
      .map(el => {
        const accessibleName = (
          (el.getAttribute('aria-label') || '').trim()
          || labelledByText(el)
          || labelText(el)
          || (el.getAttribute('title') || '').trim()
        )
        return {
          summary: summary(el),
          missingIdOrName: !(el.id || el.name),
          missingLabel: !accessibleName,
        }
      })
      .filter(item => item.missingIdOrName || item.missingLabel)
  })
}

test('@a11y every settings section exposes labels and stable ids for visible form controls', async ({ page, baseURL }) => {
  const findings = []

  for (const [path, listLabel] of SECTIONED_PAGES) {
    await page.goto(new URL(path, baseURL).toString())
    const sectionList = page.getByRole('navigation', { name: listLabel })
    await expect(sectionList.getByRole('button').first()).toBeVisible()
    // By position, not by name: a section's button can carry a note beside its title that arrives after
    // the list does, so its name is not fixed.
    const sectionCount = await sectionList.getByRole('button').count()

    for (let index = 0; index < sectionCount; index += 1) {
      const sectionButton = sectionList.getByRole('button').nth(index)
      await sectionButton.click()
      await expect(sectionButton).toHaveAttribute('aria-current', 'page')
      await page.waitForLoadState('networkidle')
      const title = await page.getByRole('heading', { level: 2 }).first().textContent()
      for (const finding of await unlabeledControls(page)) findings.push({ section: `${path} / ${title}`, ...finding })
    }
  }

  for (const path of HEADER_SECTIONS) {
    await page.goto(new URL(path, baseURL).toString())
    await page.waitForLoadState('networkidle')
    const title = await page.getByRole('heading', { level: 2 }).first().textContent()
    for (const finding of await unlabeledControls(page)) findings.push({ section: `${path} / ${title}`, ...finding })
  }

  if (findings.length) {
    console.log(JSON.stringify(findings, null, 2))
  }

  expect(findings).toEqual([])
})
