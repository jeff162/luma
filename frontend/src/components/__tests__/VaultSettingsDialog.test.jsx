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
const getCurrentUser = vi.fn(async () => ({ user: { id: 'u1', vault_has_recovery_code: false } }))
const issueVaultRecoveryCode = vi.fn(async () => ({ recovery_code: 'AAAAAAAA-BBBBBBBB-CCCCCCCC-DDDDDDDD' }))
// Presenting the secret again *is* an unlock — that is what the server records as proof — so the confirm
// prompt this dialog raises ends in the same call the lock screen makes.
const unlockVault = vi.fn(async () => ({ user: { id: 'u1', vault_proof_seconds_remaining: 300 } }))
const discardVaultRecoveryCode = vi.fn(async () => ({ user: { id: 'u1' } }))
const reissueVaultCredentials = vi.fn(async () => ({
  outcomes: [
    { connection_id: 'c1', label: 'Harborline Bank', outcome: 'reissued', detail: null },
    { connection_id: 'c2', label: 'Riverstone Credit Union', outcome: 'manual', detail: null },
  ],
  app_secrets_to_rotate: [{ provider: 'plaid' }],
  has_credentials_backups: true,
}))

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
    getCurrentUser: (...a) => getCurrentUser(...a),
    issueVaultRecoveryCode: (...a) => issueVaultRecoveryCode(...a),
    unlockVault: (...a) => unlockVault(...a),
    discardVaultRecoveryCode: (...a) => discardVaultRecoveryCode(...a),
    reissueVaultCredentials: (...a) => reissueVaultCredentials(...a),
  },
}))

const { VaultSettingsDialog } = await import('../VaultSettingsDialog.jsx')
const { AppSessionProvider } = await import('../../lib/AppSessionContext.jsx')

// Proof of a recently presented secret, as the server reports it. The dialog reads the countdown to
// decide whether to ask *before* an action that mints a new way into the vault, so the default here is a
// live window — the state most cases are not about — and the ones that are about it pass 0.
const SESSION = {
  currentUser: {
    id: 'u1',
    // Both halves matter: every gated action here needs the key in hand *and* a recently presented
    // secret, and the dialog asks a different question depending on which is missing.
    vault_unlocked: true,
    vault_proof_seconds_remaining: 300,
    vault_passphrase_min_length: 20,
    vault_passphrase_min_distinct: 6,
  },
  setCurrentUser: () => {},
}

function renderDialog(props = {}, session = SESSION) {
  return render(
    <AppSessionProvider value={session}>
      <VaultSettingsDialog
        currentUserId="u1"
        isAdmin
        onChangePassphrase={() => {}}
        onChanged={async () => {}}
        onClose={() => {}}
        {...props}
      />
    </AppSessionProvider>,
  )
}

// The same dialog with the proof window lapsed, which is what makes it ask.
const LAPSED = {
  ...SESSION,
  currentUser: { ...SESSION.currentUser, vault_proof_seconds_remaining: 0 },
}

// And with the vault shut, which makes it ask a different question. Both are missing here, as they
// always are together: locking drops the proof stamp with the key.
const LOCKED = {
  ...SESSION,
  currentUser: { ...SESSION.currentUser, vault_unlocked: false, vault_proof_seconds_remaining: 0 },
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
  getCurrentUser.mockResolvedValue({ user: { id: 'u1', vault_has_recovery_code: false } })
  issueVaultRecoveryCode.mockResolvedValue({ recovery_code: 'AAAAAAAA-BBBBBBBB-CCCCCCCC-DDDDDDDD' })
  unlockVault.mockResolvedValue({ user: { id: 'u1', vault_proof_seconds_remaining: 300 } })
  discardVaultRecoveryCode.mockResolvedValue({ user: { id: 'u1' } })
})

describe('removing the recovery code', () => {
  // Replacing a code and not recording the new one leaves `vault_has_recovery_code` true, so the recovery
  // ladder goes on offering "use your recovery code" to somebody who deliberately has none. Removing is
  // the only way to make the ladder tell the truth.
  const withCode = () => getCurrentUser.mockResolvedValue({
    user: { id: 'u1', vault_has_recovery_code: true, vault_recovery_code_issued_at: '2026-09-01' },
  })

  it('is offered only when there is a code to remove', async () => {
    renderDialog()
    expect(await screen.findByText('No recovery code')).toBeTruthy()
    expect(screen.queryByText('Remove')).toBeNull()

    cleanup()
    withCode()
    renderDialog()
    expect(await screen.findByText('Remove')).toBeTruthy()
  })

  it('confirms before removing, and says what is lost', async () => {
    // Unlike removing a passkey, which is one of several ways in. This is often the only rung between a
    // forgotten passphrase and rebuilding every connection.
    withCode()
    renderDialog()
    await userEvent.click((await screen.findByText('Remove')).closest('button'))
    expect(await screen.findByText('Remove the recovery code?')).toBeTruthy()
    expect(discardVaultRecoveryCode).not.toHaveBeenCalled()

    await userEvent.click(screen.getByText('Remove code').closest('button'))
    await waitFor(() => expect(discardVaultRecoveryCode).toHaveBeenCalled())
  })

  it('asks for proof first when the window has lapsed', async () => {
    // Removal joins the same window as adding: someone at an unlocked machine could otherwise strip every
    // way in, leaving the owner one forgotten passphrase from a rebuild.
    withCode()
    renderDialog({}, LAPSED)
    await userEvent.click((await screen.findByText('Remove')).closest('button'))
    await userEvent.click(screen.getByText('Remove code').closest('button'))
    expect(await screen.findByText('Confirm it’s you')).toBeTruthy()
    expect(discardVaultRecoveryCode).not.toHaveBeenCalled()
  })
})

describe('proof before a new way into the vault is minted', () => {
  // Adding a passkey and minting a recovery code each create a credential that keeps working after lock,
  // relock, and the owner changing their passphrase. So an open vault is not enough on its own — the
  // secret has to have been presented recently, or anyone reaching an unlocked screen could add their
  // own way in and keep it.
  it('asks first when the window has lapsed', async () => {
    renderDialog({}, LAPSED)
    await userEvent.click((await screen.findByText('Create a recovery code')).closest('button'))
    expect(await screen.findByText('Confirm it’s you')).toBeTruthy()
    expect(issueVaultRecoveryCode).not.toHaveBeenCalled()
  })

  it('does not ask while the window is live', async () => {
    // The friction this window exists to avoid: unlocking, opening this dialog and minting a code is one
    // sitting, and asking again for the secret typed seconds earlier is what makes people pick a weaker
    // one. The countdown is the server's; this only reads it.
    renderDialog()
    await userEvent.click((await screen.findByText('Create a recovery code')).closest('button'))
    await waitFor(() => expect(issueVaultRecoveryCode).toHaveBeenCalled())
    expect(screen.queryByText('Confirm it’s you')).toBeNull()
  })

  it('runs the held action once the secret is presented', async () => {
    // The user already clicked; making them find the control again after answering for it would read as
    // the click having been lost.
    unlockVault.mockResolvedValue({ user: { id: 'u1', vault_proof_seconds_remaining: 300 } })
    renderDialog({}, LAPSED)
    await userEvent.click((await screen.findByText('Create a recovery code')).closest('button'))
    await userEvent.type(await screen.findByPlaceholderText('Vault passphrase'),
                         'a-strong-vault-passphrase{Enter}')
    await waitFor(() => expect(issueVaultRecoveryCode).toHaveBeenCalled())
  })

  it('asks when the server refuses even though the local countdown said otherwise', async () => {
    // The backstop. A sleeping tab, a second session, or a restarted backend all leave the client's copy
    // saying there is time left when there is not — so the refusal has to be answerable, not just
    // reported. The client copy is allowed to be wrong; being wrong costs one prompt.
    const refusal = Object.assign(new Error('Confirm your passphrase or passkey'), {
      status: 403, detail: { code: 'proof_required' },
    })
    issueVaultRecoveryCode.mockRejectedValueOnce(refusal)
    renderDialog()
    await userEvent.click((await screen.findByText('Create a recovery code')).closest('button'))
    expect(await screen.findByText('Confirm it’s you')).toBeTruthy()
  })
})

describe('the access queue', () => {
  const WAITING = {
    requests: [{
      slot_id: 's1', user_id: 'u2', display_name: 'Frances', method: 'passphrase',
      requested_at: '2026-09-01T10:00:00', replaces_access: false,
    }],
  }

  it('answers a locked vault by asking to unlock, then approves', async () => {
    // Approving seals the key into the waiting slot, so it needs the key in hand. Reaching this dialog
    // with a locked vault is now the ordinary path — the queue is surfaced to members who have not
    // unlocked — so the 423 has to be a question rather than an error string the user must decode.
    vaultAccessRequests.mockResolvedValue(WAITING)
    approveVaultAccess.mockRejectedValueOnce(Object.assign(new Error('Unlock the vault'), { status: 423 }))
    renderDialog()
    await userEvent.click((await screen.findByText('Approve')).closest('button'))

    expect(await screen.findByText('Unlock the vault')).toBeTruthy()
    // ...and not the wording for a vault that is already open.
    expect(screen.queryByText('Confirm it’s you')).toBeNull()

    await userEvent.type(screen.getByPlaceholderText('Vault passphrase'),
                         'a-strong-vault-passphrase{Enter}')
    await waitFor(() => expect(approveVaultAccess).toHaveBeenCalledTimes(2))
  })

  it('asks to unlock before approving, without troubling the server first', async () => {
    // Approving mints a durable unlock method for somebody else, so it needs the key in hand and a
    // recently presented secret. Both are missing on a locked vault, and asking up front beats sending a
    // request that can only come back refused.
    vaultAccessRequests.mockResolvedValue(WAITING)
    renderDialog({}, LOCKED)
    await userEvent.click((await screen.findByText('Approve')).closest('button'))
    expect(await screen.findByText('Unlock the vault')).toBeTruthy()
    expect(approveVaultAccess).not.toHaveBeenCalled()
  })

  it('says when a request replaces access that already existed', async () => {
    // A newcomer enrolling and a member who lost their passphrase look identical here, and they are not
    // the same decision — the second hands back access to whoever wrote the request. The approver is the
    // only person who can tell, so the row has to say which it is.
    vaultAccessRequests.mockResolvedValue({
      requests: [{
        slot_id: 's1', user_id: 'u2', display_name: 'Frances', method: 'passphrase',
        requested_at: '2026-09-01T10:00:00', replaces_access: true,
      }],
    })
    renderDialog()
    expect(await screen.findByText(/lost their passphrase/)).toBeTruthy()
  })

  it('does not say it for an ordinary enrollment', async () => {
    vaultAccessRequests.mockResolvedValue({
      requests: [{
        slot_id: 's2', user_id: 'u3', display_name: 'Sam', method: 'passphrase',
        requested_at: '2026-09-01T10:00:00', replaces_access: false,
      }],
    })
    renderDialog()
    expect(await screen.findByText(/^asked /)).toBeTruthy()
    expect(screen.queryByText(/lost their passphrase/)).toBeNull()
  })
})

describe('recovery code', () => {
  it('shows the code once, and only after it is minted', async () => {
    // The whole contract of a shown-once secret: it is absent until asked for, present exactly once
    // afterwards, and the copy beside it says it will not come back.
    renderDialog()
    expect(await screen.findByText('No recovery code')).toBeTruthy()
    expect(screen.queryByText(/AAAAAAAA/)).toBeNull()

    await userEvent.click(screen.getByText('Create a recovery code'))
    expect(await screen.findByText(/AAAAAAAA-BBBBBBBB/)).toBeTruthy()
    expect(screen.getByText(/shown once and cannot be recovered/)).toBeTruthy()
  })
})

describe('unlock methods', () => {
  it('explains why instead of offering the control on an IP-address host', async () => {
    // The reason matters: TLS would not help here, so telling the user to configure HTTPS — the other
    // refusal's advice — would send them to do work that ends at the same wall.
    withWebAuthn()
    vaultPasskeyParams.mockResolvedValue({ available: false, reason: 'ip_address_host', rp_id: null, credentials: [] })
    renderDialog()
    expect(await screen.findByText(/named host, not an IP address/)).toBeTruthy()
    expect(screen.queryByText('Add a passkey')).toBeNull()
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
})

describe('responding to an exposure', () => {
  it('confirms, then lists what was replaced and everything still to do', async () => {
    // A connection whose provider cannot reissue, and the app secret no connection-level call retires,
    // are exactly what a user would otherwise believe the button had handled.
    renderDialog()
    await userEvent.click((await screen.findByText('Replace connection credentials…')).closest('button'))
    expect(reissueVaultCredentials).not.toHaveBeenCalled()
    await userEvent.click(screen.getByText('Replace credentials').closest('button'))
    await waitFor(() => expect(reissueVaultCredentials).toHaveBeenCalled())

    expect(await screen.findByText('Harborline Bank')).toBeTruthy()
    expect(screen.getByText(/copied credential no longer works/)).toBeTruthy()
    expect(screen.getByText(/cannot replace it from here/)).toBeTruthy()
    expect(screen.getByText('Plaid app secret')).toBeTruthy()
    expect(screen.getByText(/Credentials backups made before now/)).toBeTruthy()
    expect(screen.getByText('Change passphrase').closest('button')).toBeTruthy()
  })
})
