// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The account-mapping step for a data-source connection. The grid itself is `AccountMappingGrid`, the
// same one the CSV import and the data-source editor use, so the three ask the question identically.
//
// It is a required step after Link rather than a nicety. Connecting records what the bank offers but
// creates nothing, so an unmapped provider account has nowhere to sync into; and the mapping is what
// supplies duplicate detection its cross-account alias, without which a re-fetch of transactions
// already imported from a CSV arrives as an unrelated new account. It reopens from the connection
// card because a decision made once at connect time is exactly the kind a user revisits — and for a
// metered provider, re-linking to "start over" may not be available.

import { useEffect, useMemo, useState } from 'react'
import { AppDialog, Button, DialogActions, Spinner } from '../ui.jsx'
import AccountMappingGrid from '../importExport/AccountMappingGrid.jsx'
import { isMarketplaceAccountType } from '../../lib/accountTypes.js'
import { MONEY_DISPLAY_CONFIG } from '../../lib/moneyDisplay.js'
import {
  defaultConnectionMapEntry,
  entryFromProviderAccount,
  entryToMapping,
} from '../../lib/connectionAccountMapping.js'

export default function ConnectionAccountMapDialog({
  connection,
  providerAccounts,
  captureFields = [],
  accounts,
  saving = false,
  loading = false,
  error = null,
  onSave,
  onToggleCaptureField,
  onClose,
  // A fresh connect must resolve every account before history is pulled; reopening later to adjust
  // one mapping should not force decisions on the rest.
  requireAll = false,
}) {
  const [entries, setEntries] = useState({})
  // External account id → the nickname being edited, saved with the mapping. Blank uses the provider's label.
  const [nicknames, setNicknames] = useState({})

  const selectableAccounts = useMemo(
    // Marketplace accounts are filled by their own importer, never by pointing a data source at them —
    // the same exclusion the CSV mapping grid applies.
    () => (accounts || []).filter(a => !isMarketplaceAccountType(a.type)),
    [accounts],
  )

  useEffect(() => {
    const next = {}
    for (const pa of providerAccounts || []) {
      next[pa.external_account_id] = entryFromProviderAccount(pa, selectableAccounts)
    }
    setEntries(next)
  }, [providerAccounts, selectableAccounts])

  useEffect(() => {
    setNicknames(Object.fromEntries((providerAccounts || []).map(pa => [pa.external_account_id, pa.nickname || ''])))
  }, [providerAccounts])

  function update(externalId, patch) {
    setEntries(prev => ({
      ...prev,
      [externalId]: { ...defaultConnectionMapEntry(''), ...(prev[externalId] || {}), ...patch },
    }))
  }

  const rows = providerAccounts || []
  const undecided = rows.filter(pa => !entryToMapping(entries[pa.external_account_id]))
  const blocked = requireAll && undecided.length > 0

  function save() {
    const mappings = {}
    for (const pa of rows) {
      const mapping = entryToMapping(entries[pa.external_account_id])
      if (mapping) mappings[pa.external_account_id] = mapping
    }
    const changedNicknames = {}
    for (const pa of rows) {
      const nickname = nicknames[pa.external_account_id] ?? ''
      if (nickname !== (pa.nickname || '')) changedNicknames[pa.external_account_id] = nickname
    }
    onSave?.(mappings, changedNicknames)
  }

  return (
    <>
      {/* Two modes, two titles. Post-Link the mapping IS the job — the backfill is waiting on it — so the
          title names that one task. Reopened from the connection card it is a settings surface covering
          both the mapping and what the source captures, and a title naming only the mapping would leave
          the second section undiscoverable. */}
      <AppDialog
        title={requireAll
          ? `Map accounts from ${connection?.institution || 'this connection'}`
          : `${connection?.institution || 'Connection'} settings`}
        description={
          requireAll
            ? 'Choose what each account from this connection is. Transactions are pulled once every account has a destination — mapping an account onto one already in Luma is also what lets duplicate detection recognize transactions imported from a file.'
            : 'Adjust what each account from this connection maps to, and which details future syncs capture. Changing a mapping re-checks the transactions already pulled for duplicates.'
        }
        width="min(760px, 100%)"
        onClose={saving ? undefined : onClose}
        actions={
          <DialogActions align="between">
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {requireAll && undecided.length > 0
                ? `${undecided.length} account${undecided.length === 1 ? '' : 's'} still to decide`
                : ''}
            </span>
            <span style={{ display: 'flex', gap: 8 }}>
              <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
              <Button onClick={save} disabled={saving || blocked || loading}>
                {saving ? 'Saving…' : requireAll ? 'Continue' : 'Save mapping'}
              </Button>
            </span>
          </DialogActions>
        }
      >
        {error ? (
          <div style={{
            marginBottom: 12, padding: '8px 12px', borderRadius: 8, fontSize: 13,
            background: 'color-mix(in srgb, var(--danger) 10%, var(--surface2))',
            border: '1px solid color-mix(in srgb, var(--danger) 40%, var(--border))',
            color: 'var(--danger)',
          }}>{error}</div>
        ) : null}

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}><Spinner /></div>
        ) : rows.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
            This connection reported no accounts.
          </p>
        ) : (
          <div style={{ display: 'grid', gap: 0 }}>
            <AccountMappingGrid
              sourceHeading="Account from provider"
              namePrefix="connection-map"
              accounts={accounts}
              onUpdate={update}
              // This dialog's body already carries 20px of padding, so 4 here reads at 24 against the
              // panel edge; the card grid's 14 would indent it further than that grid sits in its card.
              padX={4}
              // The dialog body scrolls; with a dozen provider accounts the column labels would otherwise
              // scroll away and leave a bare checkbox column with nothing naming it.
              stickyHeader
              onRename={(externalId, name) => setNicknames(prev => ({
                ...prev,
                // Typing the provider's own label back is clearing the nickname.
                [externalId]: name === rows.find(pa => pa.external_account_id === externalId)?.source_label ? '' : name,
              }))}
              // Unlike a CSV's per-import skip, this one is remembered: it stops "Refresh accounts"
              // recreating an account that was deliberately rejected.
              skipTitle="Don't bring this account into Luma. Remembered, so refreshing the connection won't recreate it."
              rows={rows.map(pa => {
                const entry = { ...defaultConnectionMapEntry(pa.source_label), ...(entries[pa.external_account_id] || {}) }
                return {
                  key: pa.external_account_id,
                  label: pa.source_label,
                  displayLabel: nicknames[pa.external_account_id] || pa.source_label,
                  title: pa.provider_official_name || pa.source_label,
                  entry,
                  candidates: entry.candidates || [],
                  suggestion: entry.suggestion,
                  newNameDefault: nicknames[pa.external_account_id] || pa.provider_name || pa.source_label,
                  details: <ProviderAccountDetails providerAccount={pa} nicknamed={!!nicknames[pa.external_account_id]} />,
                }
              })}
            />
          </div>
        )}
        {captureFields.length > 0 ? (
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>Details captured from this connection</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8, lineHeight: 1.5 }}>
              Extra detail kept with each transaction, alongside the amount, date, and merchant. Some is
              always captured because duplicate detection relies on it. Changes apply to future syncs.
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px' }}>
              {captureFields.map(f => (
                <label
                  key={f.key}
                  title={f.locked ? 'Always captured — duplicate detection relies on this' : undefined}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12,
                    color: f.locked ? 'var(--muted)' : 'var(--text)',
                    cursor: f.locked ? 'default' : 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={!!f.enabled}
                    disabled={!!f.locked}
                    onChange={e => onToggleCaptureField?.(f.key, e.target.checked)}
                  />
                  {f.label}
                </label>
              ))}
            </div>
          </div>
        ) : null}
      </AppDialog>
    </>
  )
}

// What the provider says about an account beyond its label: its official name, and a currency the ledger
// cannot hold. The currency is said here, where the account is being given a destination, because
// mapping it is the decision this changes: its transactions are discarded, so the account would otherwise
// be created, sync cleanly, and stay permanently empty. The backend decides which currencies qualify
// (`currency_is_supported`) — this only renders the verdict.
// A nicknamed account also shows the provider's own label, which is what its import records carry.
function ProviderAccountDetails({ providerAccount: pa, nicknamed = false }) {
  const officialName = pa.provider_official_name && pa.provider_official_name !== pa.provider_name
    ? pa.provider_official_name
    : ''
  const providerLine = [nicknamed ? pa.source_label : '', officialName].filter(Boolean).join(' · ')
  return (
    <>
      {providerLine ? (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {providerLine}
        </div>
      ) : null}
      {pa.currency_supported === false ? (
        <div
          style={{ fontSize: 11, color: 'var(--danger)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={`This ledger is in ${MONEY_DISPLAY_CONFIG.currencyCode} and holds one currency at a time, so amounts in ${pa.provider_currency} cannot be stored alongside it. Transactions from this account are not imported — skipping it keeps it out of the way. The ledger's currency is set in Settings.`}
        >
          Held in {pa.provider_currency} — transactions not imported
        </div>
      ) : null}
    </>
  )
}
