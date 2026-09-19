// @vitest-environment jsdom

// The PayPal statement import dialog: statements grouped by the PayPal account they are for, each group
// given a PayPal account in the ledger — or shown the one its earlier statements went into — and the
// import sent with that choice. Names are invented.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({
  scanPaypalStatements: vi.fn(),
  importPaypalStatements: vi.fn(),
  getOwners: vi.fn(),
  createAccount: vi.fn(),
}))
vi.mock('../../../lib/api.js', () => ({ api }))

const { PaypalStatementImportDialog } = await import('../PaypalStatementImportDialog.jsx')

const statement = (month, overrides = {}) => ({
  key: `k-${month}`, filename: `statement-${month}.pdf`, paypal_account_id: 'robin@example.com', holder: 'Vale, Robin',
  period_start: `2026-${month}-01`, period_end: `2026-${month}-30`, transaction_count: 2, foreign_count: 0,
  already_imported: false, ...overrides,
})

const ACCOUNTS = [
  { id: 'pp1', name: 'PayPal', type: 'paypal', parent_account_id: null },
  { id: 'pp2', name: 'PayPal (Sam)', type: 'paypal', parent_account_id: null },
  { id: 'card', name: 'Harborline Card', type: 'credit', parent_account_id: null },
]
const FILES = [new File(['%PDF-'], 'statements.zip')]

function renderDialog(scan, props = {}) {
  api.scanPaypalStatements.mockResolvedValue({ accounts: {}, claimed_accounts: {}, unrecognized_files: [], unreadable_files: [], ...scan })
  const onImported = vi.fn()
  render(<PaypalStatementImportDialog files={FILES} accounts={ACCOUNTS} onClose={() => {}} onImported={onImported} {...props} />)
  return { onImported }
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.getOwners.mockResolvedValue([])
  api.importPaypalStatements.mockResolvedValue({ batches: [], skipped: [] })
})
afterEach(() => cleanup())

describe('PayPal statement import', () => {
  it('asks which PayPal account a first-seen PayPal account’s statements go into', async () => {
    const { onImported } = renderDialog({
      statements: [statement('04'), statement('06', { transaction_count: 0 })],
      claimed_accounts: { pp2: 'sam@example.com' },
    })
    const picker = await screen.findByRole('combobox', { name: 'Account for robin@example.com' })
    // Only PayPal accounts, and not one holding another PayPal account's statements.
    expect([...picker.options].map(o => o.textContent)).toEqual(['Choose the PayPal account…', 'PayPal', '＋ New PayPal account…'])
    expect(screen.getByText('no activity')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Import statements' }).disabled).toBe(true)

    await userEvent.selectOptions(picker, 'pp1')
    await userEvent.click(screen.getByRole('button', { name: 'Import statements' }))
    expect(api.importPaypalStatements).toHaveBeenCalledWith(FILES, { 'robin@example.com': 'pp1' })
    expect(onImported).toHaveBeenCalled()
  })

  it('names the account earlier statements went into instead of offering a choice', async () => {
    renderDialog({
      statements: [statement('05')],
      accounts: { 'robin@example.com': { account_id: 'pp1', account_name: 'PayPal' } },
    })
    expect(await screen.findByText('PayPal', { selector: 'strong' })).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Import statements' }))
    expect(api.importPaypalStatements).toHaveBeenCalledWith(FILES, { 'robin@example.com': 'pp1' })
  })

  it('creates a PayPal account for the statements', async () => {
    api.createAccount.mockResolvedValue({ id: 'pp-new' })
    const onAccountsChanged = vi.fn()
    renderDialog({ statements: [statement('04')] }, { onAccountsChanged })
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Account for robin@example.com' }), '__new__')
    await userEvent.clear(screen.getByRole('textbox', { name: 'New account name' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'New account name' }), 'PayPal (Robin)')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(api.createAccount).toHaveBeenCalledWith({ name: 'PayPal (Robin)', type: 'paypal' })
    expect(onAccountsChanged).toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Import statements' }))
    expect(api.importPaypalStatements).toHaveBeenCalledWith(FILES, { 'robin@example.com': 'pp-new' })
  })

  it('has nothing to import when every statement was imported before', async () => {
    renderDialog({ statements: [statement('04', { already_imported: true })] })
    expect(await screen.findByText('already imported')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.getByRole('button', { name: 'Import statements' }).disabled).toBe(true)
  })
})
