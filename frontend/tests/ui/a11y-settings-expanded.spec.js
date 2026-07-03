import { test, expect } from '@playwright/test'

const SECTION_TITLES = [
  'Appearance',
  'Backup recipients',
  'Environment variables (.env)',
  'Account security',
  'Plaid token protection',
  'User management',
  'Developer options',
  'Transaction tags',
  'Trash',
  'About',
]

test('@a11y expanded settings sections expose labels and stable ids for visible form controls', async ({ page, baseURL }) => {
  await page.goto(new URL('/settings', baseURL).toString())
  await page.waitForLoadState('networkidle')

  for (const title of SECTION_TITLES) {
    const toggle = page.getByRole('button', { name: title, exact: true })
    if (await toggle.count()) {
      await toggle.first().click()
    }
  }

  const findings = await page.evaluate(() => {
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

  if (findings.length) {
    console.log(JSON.stringify(findings, null, 2))
  }

  expect(findings).toEqual([])
})
