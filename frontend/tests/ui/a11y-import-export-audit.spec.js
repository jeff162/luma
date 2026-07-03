import { test, expect } from '@playwright/test'

const SAMPLE_CSV = `Date,Description,Amount,Account,Notes
2026-01-03,Coffee Shop,-4.75,Checking,Morning run
2026-01-04,Paycheck,1200.00,Checking,Payroll
`

function sampleCsvFile() {
  return {
    name: 'sample-transactions.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(SAMPLE_CSV, 'utf8'),
  }
}

test('@a11y audit import mapping controls for ids and labels', async ({ page, request }) => {
  await request.post('/api/auth/demo-data/clear').catch(() => null)
  await page.goto('/import-export')
  await page.getByRole('button', { name: 'Choose a data source' }).click()
  await page.getByRole('button', { name: 'Skip' }).click()
  await page.locator('#csv-file-input').setInputFiles(sampleCsvFile())
  await page.waitForLoadState('networkidle')

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
      return `${el.tagName.toLowerCase()}${attrs.length ? ` ${attrs.join('')}` : ''}${nearbyText ? ` :: ${nearbyText}` : ''}`
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

  console.log(JSON.stringify(findings, null, 2))
  expect(findings.length).toBe(0)
})
