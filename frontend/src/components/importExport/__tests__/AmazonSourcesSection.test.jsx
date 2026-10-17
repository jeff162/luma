// @vitest-environment jsdom

// Setting up a saved Amazon source, which is the surface where the account usually does not exist yet:
// the first thing a person does with Amazon is add a source, and until this was shared with the import
// form its picker could only list accounts somebody had already made somewhere else. Account and source
// names here are invented.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({
  getAmazonProfiles: vi.fn(),
  getAccounts: vi.fn(),
  getAuthStatus: vi.fn(),
  createAccount: vi.fn(),
  createAmazonProfile: vi.fn(),
  updateAmazonProfile: vi.fn(),
}))
vi.mock('../../../lib/api.js', () => ({ api }))

const AmazonSourcesSection = (await import('../AmazonSourcesSection.jsx')).default

const AMAZON_ACCOUNT = { id: 'acct-1', name: 'Amazon — household', type: 'amazon' }

function mockApi({ accounts = [] } = {}) {
  api.getAmazonProfiles.mockResolvedValue({ profiles: [] })
  api.getAccounts.mockResolvedValue(accounts)
  api.getAuthStatus.mockResolvedValue({ auth_enabled: false })
  api.createAmazonProfile.mockResolvedValue({ ok: true })
}

async function openEditor() {
  render(<AmazonSourcesSection />)
  await userEvent.click(await screen.findByRole('button', { name: '+ New Amazon source' }))
  return screen.findByLabelText('Name')
}

afterEach(() => {
  cleanup()
  for (const fn of Object.values(api)) fn.mockReset()
})

describe('AmazonSourcesSection', () => {
  it('creates the Amazon account from the source form and imports into it', async () => {
    mockApi()
    api.createAccount.mockImplementation(async () => {
      // The reload that follows is what puts the new account in the list, as the real one does.
      api.getAccounts.mockResolvedValue([AMAZON_ACCOUNT])
      return AMAZON_ACCOUNT
    })
    const nameField = await openEditor()

    await userEvent.type(nameField, 'Household orders')
    await userEvent.selectOptions(screen.getByLabelText('Import into account'), '__new__')
    await userEvent.clear(screen.getByLabelText('New account name'))
    await userEvent.type(screen.getByLabelText('New account name'), 'Amazon — household')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(api.createAccount).toHaveBeenCalledWith({
      name: 'Amazon — household', type: 'amazon',
    }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.createAmazonProfile).toHaveBeenCalled())
    expect(api.createAmazonProfile.mock.calls[0][0].account_id).toBe(AMAZON_ACCOUNT.id)
  })

  it('will not save a source with no account, since such a source takes no file', async () => {
    mockApi({ accounts: [AMAZON_ACCOUNT] })
    const nameField = await openEditor()
    await userEvent.type(nameField, 'Household orders')

    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.createAmazonProfile).not.toHaveBeenCalled()

    await userEvent.selectOptions(screen.getByLabelText('Import into account'), AMAZON_ACCOUNT.id)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.createAmazonProfile).toHaveBeenCalled())
  })
})
