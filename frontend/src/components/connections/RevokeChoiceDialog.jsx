// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AppDialog, Button } from '../ui.jsx'

// The confirmation for taking connections away: one connection's Disconnect, or removing a provider with
// its connections. Both ask the same question, so they share the wording of its answers.
//
// Removing a connection can mean two different things, and only the user knows which applies. Revoking
// at the provider ends the access everywhere, including any other install holding the same credential
// (a restored copy holds the same token as the install it came from). Removing from this install only
// leaves that access live. With nothing to revoke (no stored credential, or a provider with no
// revocation call), there is one answer and one button.
export default function RevokeChoiceDialog({
  title, description, children, offersRevoke, removeLabel = 'Remove', busy, onRevoke, onRemove, onCancel,
}) {
  return (
    <AppDialog
      title={title}
      description={description}
      onClose={busy ? undefined : onCancel}
      actions={(
        <>
          <Button variant="secondary" onClick={onCancel} disabled={!!busy}>Cancel</Button>
          {offersRevoke ? (
            <>
              <Button variant="secondary" onClick={onRemove} disabled={!!busy}>
                {busy === 'remove' ? 'Removing…' : 'Remove from this install only'}
              </Button>
              <Button variant="danger" onClick={onRevoke} disabled={!!busy}>
                {busy === 'revoke' ? 'Revoking…' : 'Revoke and remove'}
              </Button>
            </>
          ) : (
            <Button onClick={onRemove} disabled={!!busy}>{busy ? 'Removing…' : removeLabel}</Button>
          )}
        </>
      )}
    >
      {children}
    </AppDialog>
  )
}
