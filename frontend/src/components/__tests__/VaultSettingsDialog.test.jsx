// @vitest-environment jsdom

// The vault-settings surface's decisions, as opposed to its layout:
//
//   * A connection that cannot host a passkey ceremony explains itself instead of offering a control
//     that would fail. Both reasons (no HTTPS, an IP-address host) are the server's verdict, and the
//     answer they lead to is the same — use a passphrase.
//   * The access queue is shown as people to approve, and approving one is a single act with no secret
//     asked for from either side. That is the whole user-visible consequence of keypair slots.
//   * Replacing the vault key confirms first. It is not styled as destruction, because nothing is lost
//     and everyone who still has access keeps it — but the old key is gone afterwards.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const vaultAccessRequests = vi.fn(async () => ({ requests: [] }))
const vaultMembers = vi.fn(async () => ({ members: [] }))
const vaultPasskeyParams = vi.fn(async () => ({ available: true, reason: null, rp_id: 'luma.example', register_salt: 'AAAA', credentials: [] }))
const approveVaultAccess = vi.fn(async () => ({ requests: [] }))
const rotateVault = vi.fn(async () => ({ result: {} }))
const removeVaultPasskey = vi.fn(async () => ({}))
const revokeVaultAccess = vi.fn(async () => ({ ok: true }))

vi.mock('../../lib/api.js', () => ({
  api: {
    vaultAccessRequests: (...a) => vaultAccessRequests(...a),
    vaultMembers: (...a) => vaultMembers(...a),
    vaultPasskeyParams: (...a) => vaultPasskeyParams(...a),
    approveVaultAccess: (...a) => approveVaultAccess(...a),
    rotateVault: (...a) => rotateVault(...a),
    removeVaultPasskey: (...a) => removeVaultPasskey(...a),
    revokeVaultAccess: (...a) => revokeVaultAccess(...a),
    registerVaultPasskey: vi.fn(async () => ({})),
  },
}))

const { VaultSettingsDialog } = await import('../VaultSettingsDialog.jsx')

function renderDialog(props = {}) {
  return render(
    <VaultSettingsDialog
      currentUserId="u1"
      isAdmin
      onChangePassphrase={() => {}}
      onChanged={async () => {}}
      onClose={() => {}}
      {...props}
    />,
  )
}

// The dialog folds the browser's own capability into the server's verdict, so a jsdom run with no
// WebAuthn at all reports 'unsupported' whatever the server said. Tests about the *server's* reasons
// stub the browser half in, and the browser half gets a case of its own below.
function withWebAuthn() {
  window.PublicKeyCredential = function PublicKeyCredential() {}
}

afterEach(() => {
  cleanup()
  delete window.PublicKeyCredential
  vi.clearAllMocks()
  vaultAccessRequests.mockResolvedValue({ requests: [] })
  vaultMembers.mockResolvedValue({ members: [] })
  vaultPasskeyParams.mockResolvedValue({ available: true, reason: null, rp_id: 'luma.example', register_salt: 'AAAA', credentials: [] })
})

describe('unlock methods', () => {
  it('offers to add a passkey where a ceremony can run', async () => {
    withWebAuthn()
    renderDialog()
    expect(await screen.findByText('Add a passkey')).toBeTruthy()
  })

  it('explains why instead of offering the control on an IP-address host', async () => {
    // The reason matters: TLS would not help here, so telling the user to configure HTTPS — the other
    // refusal's advice — would send them to do work that ends at the same wall.
    withWebAuthn()
    vaultPasskeyParams.mockResolvedValue({ available: false, reason: 'ip_address_host', rp_id: null, credentials: [] })
    renderDialog()
    expect(await screen.findByText(/named host, not an IP address/)).toBeTruthy()
    expect(screen.queryByText('Add a passkey')).toBeNull()
  })

  it('explains the cleartext case in its own terms', async () => {
    withWebAuthn()
    vaultPasskeyParams.mockResolvedValue({ available: false, reason: 'insecure_context', rp_id: null, credentials: [] })
    renderDialog()
    expect(await screen.findByText(/need an HTTPS connection/)).toBeTruthy()
  })

  it('says so when the browser itself has no WebAuthn, whatever the server allows', async () => {
    // The server can only speak for the connection. A browser without WebAuthn has to produce its own
    // explanation, or the section would offer a button that throws on click.
    renderDialog()
    expect(await screen.findByText(/browser does not support passkeys/)).toBeTruthy()
    expect(screen.queryByText('Add a passkey')).toBeNull()
  })

  it('lists registered passkeys from its own fetch, with a way to remove each', async () => {
    // Sourced here rather than from a session prop: the prop was never re-read by the page that owns
    // it, so a passkey added in this dialog could never appear however well the registration went.
    vaultPasskeyParams.mockResolvedValue({
      available: true, reason: null, rp_id: 'luma.example',
      register_salt: 'AAAA',
      credentials: [{ slot_id: 's1', credential_id: 'c1', prf_salt: 'x', label: 'Laptop', pending: false }],
    })
    renderDialog()
    expect(await screen.findByText('Laptop')).toBeTruthy()
    await userEvent.click(screen.getByText('Remove').closest('button'))
    await waitFor(() => expect(removeVaultPasskey).toHaveBeenCalledWith('s1'))
  })
})

describe('adding a passkey', () => {
  it('says nothing was added when the ceremony does not complete', async () => {
    // The reported bug: a dismissed prompt was swallowed on the reasoning that declining is the user's
    // own answer. With the dialog left looking untouched — label still filled, no list entry, no message
    // — the honest reading was "press the button again", not "that didn't happen".
    withWebAuthn()
    navigator.credentials = {
      create: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }) },
      get: async () => null,
    }
    renderDialog()
    const label = await screen.findByPlaceholderText('Name this device (optional)')
    await userEvent.type(label, 'Laptop')
    await userEvent.click(screen.getByText('Add a passkey').closest('button'))
    expect(await screen.findByText(/closed before it finished, so nothing was added/)).toBeTruthy()
    // And the typing survives, so a retry does not start by re-entering the name.
    expect(label.value).toBe('Laptop')
  })
})

describe('vault access queue', () => {
  it('shows who can open the vault, and offers to remove them', async () => {
    // The gap this closes: the rotate copy told the user to remove someone's access first, and there
    // was nowhere to see who had it, let alone take it away.
    vaultMembers.mockResolvedValue({
      members: [
        { user_id: 'u1', display_name: 'Me', role: 'admin', method_count: 2 },
        { user_id: 'u2', display_name: 'Robin', role: 'member', method_count: 1 },
      ],
    })
    renderDialog()
    expect(await screen.findByText('Robin')).toBeTruthy()
    // Never offered against yourself — that is the "remove my last unlock method" footgun in disguise,
    // and it belongs with the unlock methods where the guard lives.
    expect(await screen.findByText('you')).toBeTruthy()
    expect(screen.getAllByText('Remove access')).toHaveLength(1)

    await userEvent.click(screen.getByText('Remove access').closest('button'))
    expect(await screen.findByText(/Remove Robin’s vault access\?/)).toBeTruthy()
    // The non-obvious part: revoking does not change the key they could already read.
    expect(await screen.findByText(/revoking alone does not change the key they could already read/)).toBeTruthy()
    // Both the row control and the confirm button carry this label; the confirm is the later one.
    const confirm = screen.getAllByText('Remove access').at(-1)
    await userEvent.click(confirm.closest('button'))
    await waitFor(() => expect(revokeVaultAccess).toHaveBeenCalledWith('u2'))
  })

  it('hides removal from a non-admin', async () => {
    vaultMembers.mockResolvedValue({
      members: [{ user_id: 'u2', display_name: 'Robin', role: 'member', method_count: 1 }],
    })
    renderDialog({ isAdmin: false })
    expect(await screen.findByText('Robin')).toBeTruthy()
    expect(screen.queryByText('Remove access')).toBeNull()
  })

  it('says plainly when nobody is waiting', async () => {
    renderDialog()
    expect(await screen.findByText('Nobody is waiting for access.')).toBeTruthy()
  })

  it('approves a request in one act, naming the person rather than a slot', async () => {
    vaultAccessRequests.mockResolvedValue({
      requests: [{ slot_id: 'slot-9', user_id: 'u2', display_name: 'Robin', requested_at: '2026-08-10' }],
    })
    renderDialog()
    expect(await screen.findByText('Robin')).toBeTruthy()
    await userEvent.click(screen.getByText('Approve').closest('button'))
    await waitFor(() => expect(approveVaultAccess).toHaveBeenCalledWith('slot-9'))
    // Nothing was asked of the approver beyond the click — no passphrase from either party, which is
    // the property the asymmetric slot exists to provide.
    expect(await screen.findByText(/Robin can now open the vault/)).toBeTruthy()
  })
})

describe('replacing the vault key', () => {
  it('confirms before rotating', async () => {
    renderDialog()
    await userEvent.click((await screen.findByText('Replace vault key…')).closest('button'))
    expect(await screen.findByText('Replace the vault key?')).toBeTruthy()
    expect(rotateVault).not.toHaveBeenCalled()
    await userEvent.click(screen.getByText('Replace key').closest('button'))
    await waitFor(() => expect(rotateVault).toHaveBeenCalled())
  })

  it('tells the user the change is not a re-link', async () => {
    // The fear this answers: "re-encrypting my credentials" sounds like it breaks the connections. It
    // does not, and someone who believes it does will never run the one action that ends a leak.
    renderDialog()
    await userEvent.click((await screen.findByText('Replace vault key…')).closest('button'))
    expect(await screen.findByText(/can no longer decrypt them, even with a copy of the database/)).toBeTruthy()
  })
})
