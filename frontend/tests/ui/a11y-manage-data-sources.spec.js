import { expect, test } from '@playwright/test'

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

async function clearAllImportProfiles(request) {
  const response = await request.get('/api/import-export/profiles')
  if (!response.ok()) return
  const profiles = await response.json()
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    await request.delete(`/api/import-export/profiles/${profile.id}`)
  }
}

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

    return Array.from(document.querySelectorAll('input, select, textarea, button[aria-haspopup="listbox"]'))
      .filter(el => {
        if (!(el instanceof HTMLElement)) return false
        if (el.tagName === 'INPUT' && el.type === 'hidden') return false
        if ('disabled' in el && el.disabled) return false
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
          hasIdOrName: el.tagName === 'BUTTON' ? !!el.id : !!(el.id || el.name),
          summary: controlSummary(el),
        }
      })
      .filter(item => !item.name || !item.hasIdOrName)
  })
}

test('@a11y manage data sources editor exposes labels for visible controls', async ({ page, request }) => {
  await clearAllImportProfiles(request)
  await page.goto('/import-export?tab=sources')
  await page.getByRole('button', { name: '+ New data source' }).click()

  await page.locator('input[type="file"][accept=".csv,text/csv"]').last().setInputFiles(sampleCsvFile())
  await expect(page.getByText('Using sample-transactions.csv as the template.')).toBeVisible()

  const findings = await collectVisibleControlFindings(page)

  if (findings.length) {
    console.log(`Manage data sources accessibility findings (${findings.length}):\n${findings.map(item => item.summary).join('\n')}`)
  }

  expect(findings, findings.map(item => item.summary).join('\n')).toEqual([])
})
