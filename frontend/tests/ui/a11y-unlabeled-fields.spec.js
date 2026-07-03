import { test, expect } from '@playwright/test'

const ROUTES = [
  '/',
  '/transactions',
  '/categories',
  '/rules',
  '/accounts',
  '/import-export',
  '/tasks',
  '/recurring',
  '/settings',
  '/help',
]

test('@a11y top-level routes expose labels for visible form controls', async ({ page, baseURL }) => {
  const findings = []

  for (const route of ROUTES) {
    await page.goto(new URL(route, baseURL).toString())
    await page.waitForLoadState('networkidle')

    const routeFindings = await page.evaluate(() => {
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

      function controlRole(el) {
        if (el.tagName === 'SELECT') return 'select'
        if (el.tagName === 'TEXTAREA') return 'textarea'
        return el.type || 'input'
      }

      function controlSummary(el) {
        const attrs = []
        if (el.id) attrs.push(`#${el.id}`)
        if (el.name) attrs.push(`[name="${el.name}"]`)
        if (el.getAttribute('data-testid')) attrs.push(`[data-testid="${el.getAttribute('data-testid')}"]`)
        if (el.placeholder) attrs.push(`[placeholder="${el.placeholder}"]`)
        const nearby = el.closest('[role="dialog"], form, section, article, aside, main, div')
        const nearbyText = textFromNode(nearby).slice(0, 120)
        return `${controlRole(el)} ${attrs.join('')}`.trim() + (nearbyText ? ` :: ${nearbyText}` : '')
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
          const name = (
            (el.getAttribute('aria-label') || '').trim()
            || labelledByText(el)
            || labelText(el)
            || (el.getAttribute('title') || '').trim()
          )
          return { name, summary: controlSummary(el) }
        })
        .filter(item => !item.name)
    })

    findings.push(...routeFindings.map(item => `${route}: ${item.summary}`))
  }

  if (findings.length) {
    console.log(`Unlabeled controls (${findings.length}):\n${findings.join('\n')}`)
  }

  expect(findings, findings.join('\n')).toEqual([])
})
