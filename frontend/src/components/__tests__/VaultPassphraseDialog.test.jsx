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
const runVaultPasskeyUnlock = vi.fn(async () => ({ ok: true, user: { id: 'u1' } }))

vi.mock('../../lib/api.js', () => ({
  api: { vaultCredentialsBackups: (...a) => vaultCredentialsBackups(...a) },
}))

// The ceremony itself is mocked: it is WebAuthn, which jsdom has no way to run. What is under test here
// is the affordance — whether the dialog offers a passkey at all, and what it does with the outcome.
vi.mock('../../lib/vaultPasskey.js', async (importOriginal) => ({
  ...(await importOriginal()),
  runVaultPasskeyUnlock: (...a) => runVaultPasskeyUnlock(...a),
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

function renderDialog(props, session = SESSION) {
  return render(
    <AppSessionProvider value={session}>
      <VaultPassphraseDialog onClose={() => {}} {...props} />
    </AppSessionProvider>,
  )
}

const withPasskey = (...passkeys) => ({
  currentUser: { ...SESSION.currentUser, vault_passkeys: passkeys },
})

afterEach(() => { cleanup(); vaultCredentialsBackups.mockClear(); runVaultPasskeyUnlock.mockClear() })

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

describe('unlocking with a passkey', () => {
  // The gap this closes: the ceremony existed and worked, but was reachable only from the vault strip on
  // the Connections tab. Every gated action raises THIS dialog, so a user who had set up a passkey to
  // avoid typing their passphrase was asked for it on every disconnect, sync, and idle-timeout re-prompt.

  it('is offered when the user has a usable passkey', async () => {
    renderDialog({ mode: 'unlock', onUnlockedByPasskey: vi.fn() }, withPasskey({ id: 'pk1' }))
    expect(screen.getByText('Unlock with a passkey')).toBeTruthy()
  })

  it('is not offered when there is no passkey to use', async () => {
    renderDialog({ mode: 'unlock', onUnlockedByPasskey: vi.fn() })
    expect(screen.queryByText('Unlock with a passkey')).toBeNull()
  })

  it('ignores a slot still awaiting approval', async () => {
    // A pending slot is registered but cannot open anything, so offering it produces a ceremony that can
    // only fail.
    renderDialog({ mode: 'unlock', onUnlockedByPasskey: vi.fn() }, withPasskey({ id: 'pk1', pending: true }))
    expect(screen.queryByText('Unlock with a passkey')).toBeNull()
  })

  it('is not offered for the modes that choose a new passphrase', async () => {
    // 'set' / 'change' / 'request' all mint or rewrap a passphrase, which a passkey cannot stand in for.
    for (const mode of ['set', 'change', 'request']) {
      cleanup()
      renderDialog({ mode, onUnlockedByPasskey: vi.fn() }, withPasskey({ id: 'pk1' }))
      expect(screen.queryByText('Unlock with a passkey')).toBeNull()
    }
  })

  it('hands the unlocked session to the host, which settles the gate', async () => {
    const onUnlockedByPasskey = vi.fn()
    renderDialog({ mode: 'unlock', onUnlockedByPasskey }, withPasskey({ id: 'pk1' }))
    await userEvent.click(screen.getByText('Unlock with a passkey').closest('button'))
    await waitFor(() => expect(onUnlockedByPasskey).toHaveBeenCalledWith({ id: 'u1' }))
  })

  it('keeps the passphrase available when the ceremony refuses', async () => {
    // Every failure leaves the vault locked, so the dialog must stay open on its fallback rather than
    // treating a refused passkey as the end of the attempt.
    runVaultPasskeyUnlock.mockResolvedValueOnce({
      ok: false, reason: 'no_prf', message: 'This authenticator cannot produce the key material.',
    })
    const onUnlockedByPasskey = vi.fn()
    const onSubmit = vi.fn()
    renderDialog({ mode: 'unlock', onUnlockedByPasskey, onSubmit }, withPasskey({ id: 'pk1' }))
    await userEvent.click(screen.getByText('Unlock with a passkey').closest('button'))
    await waitFor(() => expect(
      screen.getByText('This authenticator cannot produce the key material.')).toBeTruthy())
    expect(onUnlockedByPasskey).not.toHaveBeenCalled()
    expect(screen.getByPlaceholderText('Vault passphrase')).toBeTruthy()
  })

  it('says nothing when the user dismisses the prompt themselves', async () => {
    // A cancelled ceremony is an answer, not a fault — reporting it explains to the user what they just
    // deliberately did.
    runVaultPasskeyUnlock.mockResolvedValueOnce({ ok: false, reason: 'cancelled', message: '' })
    renderDialog({ mode: 'unlock', onUnlockedByPasskey: vi.fn() }, withPasskey({ id: 'pk1' }))
    await userEvent.click(screen.getByText('Unlock with a passkey').closest('button'))
    await waitFor(() => expect(runVaultPasskeyUnlock).toHaveBeenCalled())
    expect(screen.queryByText(/could not|cannot|failed/i)).toBeNull()
  })
})
