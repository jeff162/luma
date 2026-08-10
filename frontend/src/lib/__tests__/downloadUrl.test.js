// @vitest-environment jsdom

// Downloads used to be browser navigations (`<a href>` / `location.assign`), which hands the response
// to the browser: a 200 saves the file, but ANY error status renders the raw body in place of the app.
// That is how a locked vault turned into a JSON error page with the SPA gone. `downloadUrl` fetches
// instead, so the status is the app's to handle — these pin that it never navigates and that failures
// arrive as ordinary errors carrying `detail.code`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { downloadUrl } from '../api.js'

describe('downloadUrl', () => {
  let clicked

  beforeEach(() => {
    clicked = []
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake')
    globalThis.URL.revokeObjectURL = vi.fn()
    // Record the anchor the helper builds rather than letting jsdom attempt a navigation.
    const realCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(tag => {
      const el = realCreate(tag)
      if (tag === 'a') el.click = () => clicked.push({ href: el.href, download: el.download })
      return el
    })
  })

  afterEach(() => { vi.restoreAllMocks() })

  function respond({ ok = true, status = 200, body = {}, filename = 'luma_credentials_2026-08-10.zip' } = {}) {
    globalThis.fetch = vi.fn(async () => ({
      ok,
      status,
      statusText: 'Err',
      json: async () => body,
      blob: async () => new Blob(['zip-bytes']),
      headers: { get: name => (name === 'Content-Disposition' && filename ? `attachment; filename="${filename}"` : null) },
    }))
  }

  it('saves the file under the name the server chose', async () => {
    respond()
    await downloadUrl('/api/import-export/backup/credentials')
    expect(clicked).toEqual([{ href: 'blob:fake', download: 'luma_credentials_2026-08-10.zip' }])
  })

  it('falls back to a generic name when the server sends no disposition', async () => {
    respond({ filename: null })
    await downloadUrl('/x')
    expect(clicked[0].download).toBe('download')
  })

  it('throws on a non-200 instead of letting the browser render it', async () => {
    // The reported bug's shape exactly: 423 + a machine-readable code.
    respond({ ok: false, status: 423, body: { detail: { code: 'vault_locked', message: 'Unlock the vault.' } } })

    await expect(downloadUrl('/api/import-export/backup/credentials')).rejects.toMatchObject({
      status: 423,
      message: 'Unlock the vault.',
      detail: { code: 'vault_locked' },
    })
    expect(clicked).toEqual([])
  })

  it('still reports an error when the body is not JSON', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => { throw new Error('not json') },
      headers: { get: () => null },
    }))
    await expect(downloadUrl('/x')).rejects.toMatchObject({ status: 500 })
    expect(clicked).toEqual([])
  })
})
