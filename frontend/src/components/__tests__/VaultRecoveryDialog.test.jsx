// @vitest-environment jsdom

// The recovery dialog's decisions, as opposed to its layout. Four are policy:
//
//   * The ladder is offered in order and the destructive rung starts collapsed. Flattened into a list of
//     equal options, the cheapest way out reads as one choice among several and a user in a hurry picks
//     the loudest.
//   * The reassurance leads. Losing the passphrase costs syncing, not ledger data, and a dialog that
//     opens with the destruction is both wrong and the likelier reason someone abandons the app here.
//   * A recovery code is gated on the passphrase floor, like every other surface that chooses one — the
//     server enforces it either way, and letting the click through to be refused reads as a broken vault.
//   * The reset takes a typed confirmation, and what survives it is stated before what does not.
//
// Rendered inside <StrictMode> because that is what the app runs: this surface fetches on open, and the
// effect-mount/teardown/remount cycle is exactly where a "fetch once" guard would deadlock it on its
// spinner. A plain render() mounts once and could never see the difference.

import { StrictMode } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const vaultResetPreview = vi.fn(async () => ({
  connections: 2,
  other_members_can_unlock: [],
  own_passkeys: [],
  has_recovery_code: false,
  credentials_backups: [],
  confirm_phrase: 'RESET VAULT',
}))
const recoverVault = vi.fn(async () => ({ recovery_code: 'NEWCODE1-NEWCODE2', user: {} }))
const resetVault = vi.fn(async () => ({ connections_needing_relink: 2, revocations: [], unfinished: [], user: {} }))
const requestVaultReenrolment = vi.fn(async () => ({ user: {} }))
// The server's guessability verdict on a passphrase being chosen: every long one clears it here.
const vaultPassphraseStrength = vi.fn(async (passphrase) => ({
  acceptable: passphrase.length >= 20, score: 4, shortfall: null,
}))

vi.mock('../../lib/api.js', () => ({
  api: {
    vaultResetPreview: (...a) => vaultResetPreview(...a),
    recoverVault: (...a) => recoverVault(...a),
    resetVault: (...a) => resetVault(...a),
    requestVaultReenrolment: (...a) => requestVaultReenrolment(...a),
    vaultPassphraseStrength: (...a) => vaultPassphraseStrength(...a),
  },
}))

const { VaultRecoveryDialog } = await import('../VaultRecoveryDialog.jsx')
const { AppSessionProvider } = await import('../../lib/AppSessionContext.jsx')

const SESSION = { currentUser: { vault_passphrase_min_length: 20 } }

// The dialog holds a new passphrase until the server's verdict on it arrives, so a case that submits one
// waits for that verdict first.
async function verdictArrives(passphrase) {
  await waitFor(() => expect(vaultPassphraseStrength).toHaveBeenCalledWith(passphrase))
  await act(async () => { await vaultPassphraseStrength.mock.results.at(-1).value })
}
const STRONG = 'a replacement passphrase'

function renderDialog(props = {}) {
  return render(
    <StrictMode>
      <AppSessionProvider value={SESSION}>
        <VaultRecoveryDialog onClose={() => {}} {...props} />
      </AppSessionProvider>
    </StrictMode>,
  )
}

// The shared Button drops its click handler when disabled and never sets the DOM attribute, so a gate is
// asserted by clicking and observing that nothing was sent — not by reading `button.disabled`.
async function clickIsIgnored(label, spy) {
  await userEvent.click(screen.getByText(label).closest('button'))
  expect(spy).not.toHaveBeenCalled()
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vaultResetPreview.mockResolvedValue({
    connections: 2,
    other_members_can_unlock: [],
    own_passkeys: [],
    has_recovery_code: false,
    credentials_backups: [],
    confirm_phrase: 'RESET VAULT',
  })
  recoverVault.mockResolvedValue({ recovery_code: 'NEWCODE1-NEWCODE2', user: {} })
  resetVault.mockResolvedValue({ connections_needing_relink: 2, revocations: [], unfinished: [], user: {} })
})

describe('the ladder', () => {
  it('loads under StrictMode and leads with what is not at risk', async () => {
    renderDialog()
    expect(await screen.findByText(/transactions and accounts are not encrypted/)).toBeTruthy()
  })

  it('keeps the destructive option collapsed until it is asked for', async () => {
    renderDialog()
    expect(await screen.findByText(/None of these — rebuild the vault…/)).toBeTruthy()
    expect(screen.queryByText('Last resort')).toBeNull()

    await userEvent.click(screen.getByText(/None of these — rebuild the vault…/))
    expect(await screen.findByText('Last resort')).toBeTruthy()
  })

  it('names the member to go and ask, rather than saying somebody', async () => {
    // A count cannot be acted on and "somebody else" sends the user nowhere. The name is the whole
    // content of this rung.
    vaultResetPreview.mockResolvedValue({
      connections: 2, own_passkeys: [], has_recovery_code: false,
      other_members_can_unlock: [{ user_id: 'u2', display_name: 'Robin' }],
      credentials_backups: [], confirm_phrase: 'RESET VAULT',
    })
    renderDialog()
    expect(await screen.findByText('Robin can open this vault')).toBeTruthy()
    expect(screen.getByText(/No credential changes and no connection is reconnected/)).toBeTruthy()
  })

  it('points at a passkey the user has forgotten they registered', async () => {
    // The rung above asking anyone else at all: whoever opens this dialog is thinking about a
    // passphrase, and a passkey opens the vault from a different button entirely.
    vaultResetPreview.mockResolvedValue({
      connections: 2, other_members_can_unlock: [], has_recovery_code: false,
      own_passkeys: [{ slot_id: 's1', label: 'Laptop' }],
      credentials_backups: [], confirm_phrase: 'RESET VAULT',
    })
    renderDialog()
    expect(await screen.findByText('You have a passkey for this vault')).toBeTruthy()
    expect(screen.getByText(/Laptop/)).toBeTruthy()
  })

  it('names a backup holding the vault as the rung that costs nothing', async () => {
    vaultResetPreview.mockResolvedValue({
      connections: 2, other_members_can_unlock: [], own_passkeys: [], has_recovery_code: false,
      credentials_backups: [{ exported_at: '2026-06-01T00:00:00' }], confirm_phrase: 'RESET VAULT',
    })
    renderDialog()
    expect(await screen.findByText('A backup holding the vault is on file')).toBeTruthy()
    // The non-obvious half: a backup opens with the passphrase it was MADE under, so an older one the
    // user still remembers is a complete recovery rather than another dead end.
    expect(screen.getByText(/in force when it was taken, not\s+your current ones/)).toBeTruthy()
  })
})

describe('recovery code', () => {
  const withCode = {
    connections: 2, other_members_can_unlock: [], own_passkeys: [], has_recovery_code: true,
    credentials_backups: [], confirm_phrase: 'RESET VAULT',
  }

  it('will not submit a replacement passphrase below the floor', async () => {
    vaultResetPreview.mockResolvedValue(withCode)
    renderDialog()
    await screen.findByText('Use your recovery code')
    await userEvent.type(screen.getByPlaceholderText('Recovery code'), 'SOMECODE')
    await userEvent.type(screen.getByPlaceholderText('New vault passphrase'), 'short')
    await userEvent.type(screen.getByPlaceholderText('Confirm new passphrase'), 'short')
    await clickIsIgnored('Open the vault', recoverVault)
  })

  it('walks the fields on Enter and opens the vault from the last one', async () => {
    vaultResetPreview.mockResolvedValue(withCode)
    renderDialog()
    await screen.findByText('Use your recovery code')
    await userEvent.type(screen.getByPlaceholderText('Recovery code'), 'SOMECODE{Enter}')
    expect(document.activeElement).toBe(screen.getByPlaceholderText('New vault passphrase'))

    await userEvent.type(screen.getByPlaceholderText('New vault passphrase'), `${STRONG}{Enter}`)
    expect(document.activeElement).toBe(screen.getByPlaceholderText('Confirm new passphrase'))
    expect(recoverVault).not.toHaveBeenCalled()
    await verdictArrives(STRONG)

    await userEvent.type(screen.getByPlaceholderText('Confirm new passphrase'), `${STRONG}{Enter}`)
    expect(recoverVault).toHaveBeenCalledWith('SOMECODE', STRONG)
  })

  it('recovers and hands back the replacement code', async () => {
    vaultResetPreview.mockResolvedValue(withCode)
    renderDialog()
    await screen.findByText('Use your recovery code')
    await userEvent.type(screen.getByPlaceholderText('Recovery code'), 'SOMECODE')
    await userEvent.type(screen.getByPlaceholderText('New vault passphrase'), STRONG)
    await userEvent.type(screen.getByPlaceholderText('Confirm new passphrase'), STRONG)
    await verdictArrives(STRONG)
    await userEvent.click(screen.getByText('Open the vault').closest('button'))

    expect(recoverVault).toHaveBeenCalledWith('SOMECODE', STRONG)
    // The outcome that matters: nothing was lost, and the spent code has already been replaced.
    expect(await screen.findByText('Your vault is open again')).toBeTruthy()
    expect(screen.getByText(/NEWCODE1-NEWCODE2/)).toBeTruthy()
  })
})

describe('the reset', () => {
  async function openResetForm() {
    renderDialog()
    await userEvent.click(await screen.findByText(/None of these — rebuild the vault…/))
  }

  it('refuses to run without the typed confirmation', async () => {
    await openResetForm()
    await clickIsIgnored('Rebuild the vault', resetVault)
    await userEvent.type(screen.getByPlaceholderText('RESET VAULT'), 'yes')
    await clickIsIgnored('Rebuild the vault', resetVault)
  })

  it('is not blocked by another member, but says whose access it also ends', async () => {
    // Revised: this used to be refused outright. The disclosure reads "none of these", and answering
    // "yes, one of them does" overrules the one person who knows whether that member is reachable — so
    // the alternative is led with and named, and the consequence is stated here instead of forbidden.
    vaultResetPreview.mockResolvedValue({
      connections: 2, own_passkeys: [], has_recovery_code: false,
      other_members_can_unlock: [{ user_id: 'u2', display_name: 'Robin' }],
      credentials_backups: [], confirm_phrase: 'RESET VAULT',
    })
    resetVault.mockResolvedValue({
      connections_needing_relink: 2, revocations: [], unfinished: [],
      also_locked_out: ['Robin'], user: {},
    })
    await openResetForm()
    expect(screen.getByText(/This also ends Robin’s access/)).toBeTruthy()

    await userEvent.type(screen.getByPlaceholderText('RESET VAULT'), 'RESET VAULT')
    await userEvent.click(screen.getByText('Rebuild the vault').closest('button'))
    expect(resetVault).toHaveBeenCalledWith('lost', 'RESET VAULT')
    expect(await screen.findByText(/Robin can no longer open the vault either/)).toBeTruthy()
  })

  it('never rebuilds on an Enter keystroke', async () => {
    // The one irreversible action in the app. The typed confirmation exists to make it a considered act,
    // so a field that fires it on Enter would hand back exactly what the confirmation was added to take
    // away — the click is the only way through, deliberately.
    await openResetForm()
    await userEvent.type(screen.getByPlaceholderText('RESET VAULT'), 'RESET VAULT{Enter}')
    expect(resetVault).not.toHaveBeenCalled()
  })

  it('names the connections the user still has to revoke by hand', async () => {
    // The half a reset cannot do for them. Left off the screen, a user believes a credential is dead
    // when it is still live at the provider.
    resetVault.mockResolvedValue({
      connections_needing_relink: 2,
      revocations: [],
      unfinished: [{ connection_id: 'c1', label: 'Harborline Bank', outcome: 'manual', detail: null }],
      user: {},
    })
    await openResetForm()
    await userEvent.type(screen.getByPlaceholderText('RESET VAULT'), 'RESET VAULT')
    await userEvent.click(screen.getByText('Rebuild the vault').closest('button'))

    expect(await screen.findByText('Still to do at the provider')).toBeTruthy()
    expect(screen.getByText('Harborline Bank')).toBeTruthy()
    expect(screen.getByText(/stays live until you do/)).toBeTruthy()
  })

  it('names the app secret to rotate even when every connection was revoked', async () => {
    // Revoking a connection retires its token, not the app secret it was authorized under — so a
    // clean revocation of every connection still leaves this to do, and is the case it would be missed.
    resetVault.mockResolvedValue({
      connections_needing_relink: 2, revocations: [], unfinished: [],
      app_secrets_to_rotate: [{ provider: 'plaid' }], user: {},
    })
    await openResetForm()
    await userEvent.type(screen.getByPlaceholderText('RESET VAULT'), 'RESET VAULT')
    await userEvent.click(screen.getByText('Rebuild the vault').closest('button'))

    expect(await screen.findByText('Still to do at the provider')).toBeTruthy()
    expect(screen.getByText('Plaid app secret')).toBeTruthy()
  })
})

describe('asking another member to let you back in', () => {
  // Rung 1 used to be prose: "set a new vault passphrase from the Connections tab". There is no such
  // control while the vault is locked, and the call behind it refused this very user — their slot still
  // holds the key they cannot reach. So the rung now carries the fields itself, as rung 2 already did.
  const REENROL = 'a brand new vault passphrase'

  function withMember() {
    vaultResetPreview.mockResolvedValue({
      connections: 2,
      other_members_can_unlock: [{ user_id: 'u2', display_name: 'Robin' }],
      own_passkeys: [],
      has_recovery_code: false,
      credentials_backups: [],
      confirm_phrase: 'RESET VAULT',
    })
  }

  it('submits the new passphrase from inside the rung', async () => {
    withMember()
    renderDialog()
    await userEvent.type(await screen.findByPlaceholderText('New passphrase'), REENROL)
    await userEvent.type(screen.getByPlaceholderText('Confirm new passphrase'), REENROL)
    await verdictArrives(REENROL)
    await userEvent.click(screen.getByText('Ask to be let back in').closest('button'))
    await waitFor(() => expect(requestVaultReenrolment).toHaveBeenCalledWith(REENROL))
  })

  it('holds the new passphrase to the floor before asking', async () => {
    withMember()
    renderDialog()
    await userEvent.type(await screen.findByPlaceholderText('New passphrase'), 'short')
    await userEvent.click(screen.getByText('Ask to be let back in').closest('button'))
    expect(requestVaultReenrolment).not.toHaveBeenCalled()
  })

  it('is absent when nobody else could approve it', async () => {
    // Without another member this would be a self-brick — the only slot holding the key replaced by one
    // that does not, with no one able to seal it back. The server refuses it too; this is the rung
    // simply not being offered.
    renderDialog()
    expect(await screen.findByText(/transactions/i)).toBeTruthy()
    expect(screen.queryByText('Ask to be let back in')).toBeNull()
  })
})
