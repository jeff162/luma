// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The account-mapping step for a data-source connection — the counterpart to the CSV import's
// "Account from file → Maps To → Skip" grid, and deliberately the *same interaction model*, not merely
// a similar-looking one (see ui-patterns.md → Import-specific patterns).
//
// That means the primary question is "which account?" — one select of existing accounts, a `+New`
// beside it, and a Skip checkbox — with *grouping* treated as a refinement behind
// `PossibleAccountMatchChooserDialog`, surfaced as a chip. An earlier version asked for the
// relationship FIRST, in a dropdown of the backend's mapping modes. That exposed the data model
// rather than the decision: grouping is a subtlety most mappings never need, so putting it in the
// primary control made every row look like a decision, and it asked the user to classify a
// relationship before naming the account it was with.
//
// It is a required step after Link rather than a nicety. Connecting records what the bank offers but
// creates nothing, so an unmapped provider account has nowhere to sync into; and the mapping is what
// supplies duplicate detection its cross-account alias, without which a re-fetch of transactions
// already imported from a CSV arrives as an unrelated new account. It reopens from the connection
// card because a decision made once at connect time is exactly the kind a user revisits — and for a
// metered provider, re-linking to "start over" may not be available.
//
// The suggestion + relationship machinery is the CSV flow's, reused rather than reimplemented:
// `findLikelyAccountMatch` / `getAccountMatchLabel` / `guessNewAccountTypeFromName` from
// `lib/importExport/importAccountMatching.js` and the chooser dialog itself, so both surfaces suggest
// and classify identically from one implementation.

import { useEffect, useMemo, useState } from 'react'
import { AppDialog, Button, DialogActions, Select, Spinner } from '../ui.jsx'
import { PossibleAccountMatchChooserDialog } from '../importExport/importConfirmDialogs.jsx'
import {
  getAccountMatchLabel,
  getAccountOptionLabel,
  guessNewAccountTypeFromName,
  selectableAccountOptions,
} from '../../lib/importExport/importAccountMatching.js'
import { GENERIC_IMPORT_ACCOUNT_TYPES, isMarketplaceAccountType } from '../../lib/accountTypes.js'
import {
  defaultConnectionMapEntry,
  entryFromProviderAccount,
  entryToMapping,
} from '../../lib/connectionAccountMapping.js'

const GRID = '1fr 16px 240px 52px'

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
  const [chooser, setChooser] = useState(null)

  const selectableAccounts = useMemo(
    // Marketplace accounts are filled by their own importer, never by pointing a data source at them —
    // the same exclusion the CSV mapping grid applies.
    () => (accounts || []).filter(a => !isMarketplaceAccountType(a.type)),
    [accounts],
  )
  const accountsById = useMemo(() => new Map((accounts || []).map(a => [a.id, a])), [accounts])

  useEffect(() => {
    const next = {}
    for (const pa of providerAccounts || []) {
      next[pa.external_account_id] = entryFromProviderAccount(pa, selectableAccounts)
    }
    setEntries(next)
  }, [providerAccounts, selectableAccounts])

  function update(externalId, patch) {
    setEntries(prev => ({
      ...prev,
      [externalId]: { ...defaultConnectionMapEntry(''), ...(prev[externalId] || {}), ...patch },
    }))
  }

  function openChooser(pa, target) {
    setChooser({
      externalId: pa.external_account_id,
      csvValue: pa.source_label,
      targetAccountId: target.id,
      targetLabel: getAccountMatchLabel(target) || target.name || '',
    })
  }

  // The three chooser outcomes, resolved onto the same fields the CSV flow sets
  // (`applyAccountMatchChoice`). Keeping the shapes identical is what will make the two grids
  // extractable later without reconciling two vocabularies first.
  function applyChoice(choice) {
    const pending = chooser
    setChooser(null)
    if (!pending?.targetAccountId) return
    const target = accountsById.get(pending.targetAccountId)
    if (!target) return
    const base = {
      accountId: '',
      createNew: true,
      groupWithAccountId: '',
      skip: false,
    }
    if (choice === 'map_existing') {
      update(pending.externalId, {
        ...base,
        createNew: false,
        accountId: target.id,
        newName: target.name || pending.csvValue,
        newType: target.type || 'depository',
      })
    } else if (choice === 'group_with_existing') {
      update(pending.externalId, { ...base, groupWithAccountId: target.id })
    } else {
      update(pending.externalId, base)  // keep_separate — a plain new account, no relationship
    }
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
    onSave?.(mappings)
  }

  const inputStyle = {
    width: '100%', background: 'var(--surface2)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 6, padding: '4px 6px', fontSize: 12, outline: 'none',
  }
  const iconButtonStyle = {
    flexShrink: 0, background: 'none', border: '1px solid var(--border)', borderRadius: 6,
    color: 'var(--muted)', cursor: 'pointer', fontSize: 13, width: 28, height: 28, lineHeight: 1, padding: 0,
  }
  const chipStyle = {
    justifySelf: 'start', maxWidth: '100%',
    border: '1px solid color-mix(in srgb, var(--accent2) 28%, var(--border))',
    background: 'color-mix(in srgb, var(--accent2) 10%, var(--surface2))',
    color: 'var(--accent2)', borderRadius: 999, padding: '4px 9px',
    fontSize: 11, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  }

  return (
    <>
      <AppDialog
        title={`Map accounts from ${connection?.institution || 'this data source'}`}
        description={
          requireAll
            ? 'Choose what each account from this data source is. Transactions are pulled once every account has a destination — mapping an account onto one already in Luma is also what lets duplicate detection recognize transactions imported from a file.'
            : 'Adjust what each account from this data source maps to. Changing a mapping re-checks the transactions already pulled for duplicates.'
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
              <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
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
            This data source reported no accounts.
          </p>
        ) : (
          <div style={{ display: 'grid', gap: 0 }}>
            <div style={{
              display: 'grid', gridTemplateColumns: GRID,
              gap: 12, padding: '6px 4px', fontSize: 11, fontWeight: 600, color: 'var(--muted)',
              borderBottom: '1px solid var(--border)',
            }}>
              <span>Account from data source</span>
              <span />
              <span>Maps To</span>
              <span style={{ textAlign: 'center' }}>Skip</span>
            </div>

            {rows.map(pa => {
              const externalId = pa.external_account_id
              const entry = { ...defaultConnectionMapEntry(pa.source_label), ...(entries[externalId] || {}) }
              const suggestion = entry.suggestion
              const suggestionLabel = getAccountMatchLabel(suggestion) || suggestion?.name || ''
              const relationshipTargetId = entry.groupWithAccountId || ''
              const relationshipTarget = relationshipTargetId ? accountsById.get(relationshipTargetId) : null
              const relationshipLabel = getAccountMatchLabel(relationshipTarget) || relationshipTarget?.name || ''
              const materialized = entry.materializedAccountId
                ? accountsById.get(entry.materializedAccountId)
                : null

              return (
                <div key={externalId} style={{
                  display: 'grid', gridTemplateColumns: GRID,
                  gap: 12, padding: '9px 4px', alignItems: 'center',
                  borderBottom: '1px solid var(--border)',
                  opacity: entry.skip ? 0.45 : 1,
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={pa.provider_official_name || pa.source_label}
                    >
                      {pa.source_label}
                    </div>
                    {pa.provider_official_name && pa.provider_official_name !== pa.provider_name ? (
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {pa.provider_official_name}
                      </div>
                    ) : null}
                  </div>

                  <span style={{ color: 'var(--muted)', textAlign: 'center', fontSize: 11 }}>→</span>

                  {entry.skip ? (
                    <span style={{ fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>
                      not imported
                    </span>
                  ) : !entry.createNew ? (
                    <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
                        <Select
                          name={`connection-map-target-${externalId}`}
                          value={entry.accountId}
                          onChange={v => update(externalId, {
                            accountId: v,
                            createNew: false,
                            groupWithAccountId: '',
                          })}
                          // Per row, not once for the grid: the merged child each list carries is the
                          // one THIS row's mapping is on, so two rows can offer different lists.
                          options={[
                            { value: '', label: '— Select —' },
                            ...selectableAccountOptions(selectableAccounts, entry.accountId).map(a => ({
                              value: a.id,
                              label: getAccountOptionLabel(a, accountsById),
                            })),
                          ]}
                          style={{ width: 170, maxWidth: '100%', fontSize: 12, padding: '5px 6px' }}
                        />
                        {entry.accountId ? (
                          <button
                            type="button"
                            onClick={() => update(externalId, {
                              accountId: '',
                              createNew: false,
                              newName: pa.provider_name || pa.source_label,
                              groupWithAccountId: '',
                            })}
                            style={iconButtonStyle}
                            aria-label="Clear account mapping"
                          >
                            ×
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              // A likely match makes the relationship the real question, so ask it
                              // rather than assuming a plain new account — same as the CSV grid.
                              if (suggestion) { openChooser(pa, suggestion); return }
                              update(externalId, {
                                createNew: true,
                                newName: pa.provider_name || pa.source_label,
                                newType: entry.newType || guessNewAccountTypeFromName(pa.source_label),
                                groupWithAccountId: '',
                              })
                            }}
                            style={{
                              flexShrink: 0, background: 'none', border: '1px solid var(--border)',
                              borderRadius: 6, color: 'var(--accent2)', cursor: 'pointer',
                              fontSize: 11, padding: '4px 7px', whiteSpace: 'nowrap',
                            }}
                          >+New</button>
                        )}
                      </div>
                      {!entry.accountId && suggestionLabel ? (
                        <button
                          type="button"
                          onClick={() => openChooser(pa, suggestion)}
                          style={{ ...chipStyle, justifySelf: 'end' }}
                          title={`Decide how this relates to ${suggestionLabel}`}
                        >
                          Possible match: {suggestionLabel}
                        </button>
                      ) : null}
                    </div>
                  ) : (
                    <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
                      {materialized ? (
                        // Already created by an earlier save. Name/type editors here would offer edits
                        // the mapping call ignores (it only names an account it is creating), so the
                        // row states what exists and keeps the relationship editable.
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
                          <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {materialized.name}{materialized.mask ? ` ···${materialized.mask}` : ''}
                          </span>
                          <button
                            type="button"
                            onClick={() => update(externalId, {
                              createNew: false,
                              accountId: '',
                              groupWithAccountId: '',
                            })}
                            style={iconButtonStyle}
                            aria-label="Map to a different account instead"
                          >
                            ×
                          </button>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: 4, alignItems: 'center', minWidth: 0, flexWrap: 'nowrap' }}>
                          <div style={{ width: 132, maxWidth: '100%' }}>
                            <input
                              name={`connection-map-name-${externalId}`}
                              value={entry.newName}
                              onChange={e => update(externalId, { newName: e.target.value })}
                              placeholder="Name"
                              style={{
                                ...inputStyle,
                                border: `1px solid ${
                                  selectableAccounts.some(a => a.name.toLowerCase() === (entry.newName || '').trim().toLowerCase())
                                    ? 'var(--danger)' : 'var(--accent)'
                                }`,
                              }}
                            />
                            {selectableAccounts.some(a => a.name.toLowerCase() === (entry.newName || '').trim().toLowerCase()) ? (
                              <div style={{ fontSize: 10, color: 'var(--danger)', marginTop: 2 }}>
                                Name already exists — select it instead
                              </div>
                            ) : null}
                          </div>
                          <Select
                            name={`connection-map-type-${externalId}`}
                            value={entry.newType}
                            onChange={v => update(externalId, { newType: v })}
                            options={[
                              { value: '', label: '— Type —' },
                              ...GENERIC_IMPORT_ACCOUNT_TYPES.map(o => ({ value: o.value, label: o.shortLabel })),
                            ]}
                            style={{ width: 88, fontSize: 11, padding: '4px 5px' }}
                          />
                          <button
                            type="button"
                            onClick={() => update(externalId, {
                              createNew: false,
                              accountId: '',
                              groupWithAccountId: '',
                            })}
                            style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 13, padding: 2, flexShrink: 0 }}
                            aria-label="Cancel creating a new account"
                          >✕</button>
                        </div>
                      )}
                      {relationshipTarget && relationshipLabel ? (
                        <button
                          type="button"
                          onClick={() => openChooser(pa, relationshipTarget)}
                          style={chipStyle}
                          title={`Change how this relates to ${relationshipLabel}`}
                        >
                          Grouped with {relationshipLabel}
                        </button>
                      ) : null}
                    </div>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <input
                      name={`connection-map-skip-${externalId}`}
                      type="checkbox"
                      checked={entry.skip}
                      onChange={e => update(externalId, {
                        skip: e.target.checked,
                        ...(e.target.checked
                          ? { accountId: '', createNew: false, groupWithAccountId: '' }
                          : {}),
                      })}
                      aria-label={`Don't import ${pa.source_label}`}
                      // Unlike a CSV's per-import skip, this one is remembered: it stops "Refresh
                      // accounts" recreating an account that was deliberately rejected.
                      title="Don't bring this account into Luma. Remembered, so refreshing the connection won't recreate it."
                      style={{ width: 15, height: 15, cursor: 'pointer', accentColor: 'var(--accent)' }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {captureFields.length > 0 ? (
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>Details captured from this data source</div>
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

      {chooser ? (
        <PossibleAccountMatchChooserDialog
          pending={chooser}
          onSelect={applyChoice}
          onCancel={() => setChooser(null)}
        />
      ) : null}
    </>
  )
}
