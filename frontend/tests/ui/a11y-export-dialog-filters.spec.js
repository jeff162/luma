import { expect, test } from '@playwright/test'

async function collectVisibleControlFindings(page) {
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

    function controlRole(el) {
      if (el.tagName === 'SELECT') return 'select'
      if (el.tagName === 'TEXTAREA') return 'textarea'
      return el.type || 'input'
    }

    function controlSummary(el) {
      const attrs = []
      if (el.id) attrs.push(`#${el.id}`)
      if (el.name) attrs.push(`[name="${el.name}"]`)
      if (el.placeholder) attrs.push(`[placeholder="${el.placeholder}"]`)
      return `${controlRole(el)} ${attrs.join(' ')}`.trim()
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
        return {
          name,
          hasIdOrName: !!(el.id || el.name),
          summary: controlSummary(el),
        }
      })
      .filter(item => !item.name || !item.hasIdOrName)
  })
}

test('@a11y export dialog filter controls stay labeled', async ({ page, baseURL }) => {
  const findings = []

  await page.goto(new URL('/transactions', baseURL).toString())
  await page.waitForLoadState('networkidle')

  await page.getByRole('button', { name: 'Export…' }).click()
  const dialog = page.locator('[data-modal-overlay]')
  await dialog.getByRole('button', { name: 'Date' }).click()
  findings.push(...(await collectVisibleControlFindings(page)).map(item => `export/date: ${item.summary}`))

  await dialog.getByRole('button', { name: 'Filter' }).click()
  await dialog.getByRole('button', { name: 'Payee' }).click()
  findings.push(...(await collectVisibleControlFindings(page)).map(item => `export/filter: ${item.summary}`))

  if (findings.length) {
    console.log(`Export dialog accessibility findings (${findings.length}):\n${findings.join('\n')}`)
  }

  expect(findings, findings.join('\n')).toEqual([])
})
