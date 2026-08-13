// @vitest-environment jsdom

// The passphrase dialog's two behaviours that are policy rather than presentation:
//
//   * The floor is a GATE, not advice. A passphrase under it cannot be submitted at all. Before this the
//     strength meter was the only signal, so a short passphrase was accepted by the UI and then refused
//     by the server — which reads as the vault being broken rather than as a rule being applied.
//   * Changing the passphrase says which credentials backups it strands. Rewrapping the DEK leaves every
//     file exported beforehand restorable only with the old passphrase, permanently, and nothing else on
//     screen would ever reveal that.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const vaultCredentialsBackups = vi.fn(async () => ({ backups: [] }))

vi.mock('../../lib/api.js', () => ({
  api: { vaultCredentialsBackups: (...a) => vaultCredentialsBackups(...a) },
}))

const { VaultPassphraseDialog } = await import('../VaultPassphraseDialog.jsx')
const { AppSessionProvider } = await import('../../lib/AppSessionContext.jsx')

// Blocking is asserted by clicking and observing that nothing was submitted, rather than by reading
// `button.disabled`: the shared `Button` expresses a disabled state by dimming and dropping its click
// handler, and never sets the DOM attribute — so the attribute would be false however well the gate
// works. What matters here is that the click cannot get through, which is what these check.
async function clickIsIgnored(label, onSubmit) {
  await userEvent.click(screen.getByText(label).closest('button'))
  expect(onSubmit).not.toHaveBeenCalled()
}

// The limits the server would serve. Passed through the session exactly as the app does, so the dialog is
// exercised against served numbers rather than its own fallbacks.
const SESSION = {
  currentUser: { vault_passphrase_min_length: 20, vault_passphrase_min_distinct: 6 },
}

function renderDialog(props) {
  return render(
    <AppSessionProvider value={SESSION}>
      <VaultPassphraseDialog onClose={() => {}} {...props} />
    </AppSessionProvider>,
  )
}

afterEach(() => { cleanup(); vaultCredentialsBackups.mockClear() })

describe('the passphrase floor is enforced, not suggested', () => {
  it('blocks submit below the length floor and says how much is missing', async () => {
    const onSubmit = vi.fn()
    renderDialog({ mode: 'set', onSubmit })
    await userEvent.type(screen.getByPlaceholderText('Vault passphrase'), 'too-short')

    expect(await screen.findByText('11 more characters needed (at least 20).')).toBeTruthy()
    await clickIsIgnored('Set passphrase', onSubmit)
  })

  it('blocks a long passphrase built from too few distinct characters', async () => {
    const onSubmit = vi.fn()
    renderDialog({ mode: 'set', onSubmit })
    await userEvent.type(screen.getByPlaceholderText('Vault passphrase'), 'abababababababababababab')
    expect(await screen.findByText('Use at least 6 different characters.')).toBeTruthy()
    await clickIsIgnored('Set passphrase', onSubmit)
  })

  it('allows one that clears the floor', async () => {
    const onSubmit = vi.fn()
    renderDialog({ mode: 'set', onSubmit })
    await userEvent.type(screen.getByPlaceholderText('Vault passphrase'), 'a-strong-vault-passphrase')
    await userEvent.type(screen.getByPlaceholderText('Confirm passphrase'), 'a-strong-vault-passphrase')
    await userEvent.click(screen.getByText('Set passphrase').closest('button'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('a-strong-vault-passphrase'))
  })

  it('applies no floor to unlocking — that passphrase already exists', async () => {
    // Gating the unlock field would lock a user out of their own vault the moment the floor moved.
    const onSubmit = vi.fn()
    renderDialog({ mode: 'unlock', onSubmit })
    await userEvent.type(screen.getByPlaceholderText('Vault passphrase'), 'short')
    await userEvent.click(screen.getByText('Unlock').closest('button'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('short'))
  })
})

describe('changing the passphrase', () => {
  it('names the credentials backups the change would strand', async () => {
    vaultCredentialsBackups.mockResolvedValueOnce({ backups: [{ exported_at: '2026-08-11T10:00:00Z' }] })
    renderDialog({ mode: 'change', onSubmit: vi.fn() })
    expect(await screen.findByText(/Aug 11, 2026/)).toBeTruthy()
    expect(screen.getByText(/can only be restored with it/)).toBeTruthy()
  })

  it('still cautions when no backup is on record, since one may predate the record', async () => {
    renderDialog({ mode: 'change', onSubmit: vi.fn() })
    expect(await screen.findByText(/Any credentials backup taken before now/)).toBeTruthy()
  })

  it('sends the old and new passphrases together', async () => {
    const onSubmit = vi.fn()
    renderDialog({ mode: 'change', onSubmit })
    await userEvent.type(screen.getByPlaceholderText('Current passphrase'), 'the-old-one')
    await userEvent.type(screen.getByPlaceholderText('New passphrase'), 'a-strong-vault-passphrase')
    await userEvent.type(screen.getByPlaceholderText('Confirm new passphrase'), 'a-strong-vault-passphrase')
    await userEvent.click(screen.getByText('Change passphrase').closest('button'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      current: 'the-old-one', next: 'a-strong-vault-passphrase',
    }))
  })

  it('holds the new passphrase to the same floor as a first one', async () => {
    const onSubmit = vi.fn()
    renderDialog({ mode: 'change', onSubmit })
    await userEvent.type(screen.getByPlaceholderText('New passphrase'), 'too-short')
    expect(await screen.findByText('11 more characters needed (at least 20).')).toBeTruthy()
    await clickIsIgnored('Change passphrase', onSubmit)
  })
})
