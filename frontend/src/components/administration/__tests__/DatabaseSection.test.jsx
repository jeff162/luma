// @vitest-environment jsdom

// Settings -> Database: a failed check always comes with its next step. The index rebuild is offered only
// where the server says it repairs what was found; anything else points at a backup, naming the newest one
// made from databases that passed.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const repairDatabaseIndexes = vi.fn()

vi.mock('../../../lib/api.js', () => ({
  api: { repairDatabaseIndexes: (...args) => repairDatabaseIndexes(...args) },
}))
vi.mock('../../settings/ImportStorageSection.jsx', () => ({ default: () => null }))

const { default: DatabaseSection } = await import('../DatabaseSection.jsx')

afterEach(() => { cleanup(); repairDatabaseIndexes.mockReset() })

const PASSED = { ok: true, problems: [], orphans: [], indexes_repairable: false }
const INDEX_ONLY = { ok: false, problems: ['row 3 missing from index child_body'], orphans: [], indexes_repairable: true }
const ORPHANS = { ok: false, problems: [], orphans: [{ table: 'txn_tag', parent: 'tag', rows: 2 }], indexes_repairable: false }

function renderWith(data, { backups = [], setState = vi.fn() } = {}) {
  const db = {
    state: { check: { ok: data.ok, databases: { data, accounts: PASSED } }, usage: null },
    setState, backups, error: '', load: vi.fn(),
  }
  render(<DatabaseSection db={db} storage={null} />)
  return db
}

describe('the database check', () => {
  it('offers the index rebuild when indexes are all that is wrong, and shows the check that follows', async () => {
    const after = { check: { ok: true, databases: { data: PASSED, accounts: PASSED } }, usage: null }
    repairDatabaseIndexes.mockResolvedValue(after)
    const db = renderWith(INDEX_ONLY)
    expect(screen.getByText(/Rebuilding the indexes repairs that without losing anything/)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Rebuild indexes' }))

    await waitFor(() => expect(db.setState).toHaveBeenCalledWith(after))
  })

  it('points at the newest backup that passed when nothing here repairs the problem', () => {
    renderWith(ORPHANS, {
      backups: [
        { made_at: '2026-10-20T12:00:00', database_check: 'failed' },
        { made_at: '2026-10-01T12:00:00', database_check: 'passed' },
      ],
    })
    expect(screen.getByText(/2 rows in txn_tag refer to a tag row that no longer exists/)).toBeTruthy()
    expect(screen.getByText(/newest backup made from databases that passed their check/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Rebuild indexes' })).toBeNull()
  })
})
