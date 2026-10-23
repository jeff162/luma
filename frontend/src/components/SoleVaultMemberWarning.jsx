// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The warning itself, for the body of the confirmation. Delete stays available: removing the person is
// the administrator's call, and the reset only clears what nobody could open any more.
export default function SoleVaultMemberWarning({ name }) {
  return (
    <div style={{
      fontSize: 13, lineHeight: 1.5, borderRadius: 8, padding: '8px 12px',
      background: 'color-mix(in srgb, var(--warning, #d97706) 12%, var(--surface2))',
      border: '1px solid color-mix(in srgb, var(--warning, #d97706) 35%, var(--border))',
    }}>
      {name} is the only user who can open the credential vault. Deleting them clears the stored credentials,
      and any data sources will need reconnecting. To keep them, set a vault passphrase first and
      have {name} approve it.
    </div>
  )
}
