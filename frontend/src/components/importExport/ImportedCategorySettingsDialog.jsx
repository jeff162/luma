// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Dialog for scoping which owners / unassigned-account buckets contribute their
// file categories during an import that uses categories present in the data.
// Owns its own transient checkbox selection (seeded from the passed-in settings)
// and folds "everything checked" back into the ALL scope on save so the stored
// settings only record FILTERED when the user actually narrowed the scope.

import { useEffect, useMemo, useState } from 'react'
import {
  Button,
  DialogActions,
  FloatingPanel,
  FloatingPanelHeader,
  OverlayBackdrop,
} from '../ui.jsx'
import {
  IMPORTED_CATEGORY_FILTER_DIALOG_TITLE,
  IMPORTED_CATEGORY_FILTER_DIALOG_DESCRIPTION,
  IMPORTED_CATEGORY_SCOPE_ALL,
  IMPORTED_CATEGORY_SCOPE_FILTERED,
} from '../../lib/importExport/constants.js'
import {
  dedupeStringList,
  normalizeImportedCategorySettings,
} from '../../lib/importExport/importedCategorySettings.js'

export function ImportedCategorySettingsDialog({
  title = IMPORTED_CATEGORY_FILTER_DIALOG_TITLE,
  description = IMPORTED_CATEGORY_FILTER_DIALOG_DESCRIPTION,
  choices = [],
  initialSettings,
  onSave,
  onCancel,
}) {
  const normalizedInitial = useMemo(
    () => normalizeImportedCategorySettings(initialSettings),
    [initialSettings],
  )
  const ownerChoices = useMemo(
    () => choices.filter(choice => choice.kind === 'owner'),
    [choices],
  )
  const accountChoices = useMemo(
    () => choices.filter(choice => choice.kind === 'account'),
    [choices],
  )
  const allOwnerIds = useMemo(
    () => ownerChoices.map(choice => choice.ownerId),
    [ownerChoices],
  )
  const allAccountTokens = useMemo(
    () => accountChoices.map(choice => choice.token),
    [accountChoices],
  )
  const [selectedOwnerIds, setSelectedOwnerIds] = useState(
    normalizedInitial.scope_mode === IMPORTED_CATEGORY_SCOPE_FILTERED
      ? normalizedInitial.owner_ids
      : allOwnerIds,
  )
  const [selectedAccountTokens, setSelectedAccountTokens] = useState(
    normalizedInitial.scope_mode === IMPORTED_CATEGORY_SCOPE_FILTERED
      ? normalizedInitial.unassigned_account_tokens
      : allAccountTokens,
  )

  useEffect(() => {
    const next = normalizeImportedCategorySettings(initialSettings)
    setSelectedOwnerIds(next.scope_mode === IMPORTED_CATEGORY_SCOPE_FILTERED ? next.owner_ids : allOwnerIds)
    setSelectedAccountTokens(next.scope_mode === IMPORTED_CATEGORY_SCOPE_FILTERED ? next.unassigned_account_tokens : allAccountTokens)
  }, [initialSettings, allOwnerIds, allAccountTokens])

  function toggleOwner(ownerId) {
    setSelectedOwnerIds(prev => prev.includes(ownerId)
      ? prev.filter(value => value !== ownerId)
      : [...prev, ownerId]
    )
  }

  function toggleAccount(token) {
    setSelectedAccountTokens(prev => prev.includes(token)
      ? prev.filter(value => value !== token)
      : [...prev, token]
    )
  }

  function handleSave() {
    const normalizedOwnerIds = dedupeStringList(selectedOwnerIds)
    const normalizedAccountTokens = dedupeStringList(selectedAccountTokens)
    const includesAllOwners = normalizedOwnerIds.length === allOwnerIds.length
      && allOwnerIds.every(ownerId => normalizedOwnerIds.includes(ownerId))
    const includesAllAccounts = normalizedAccountTokens.length === allAccountTokens.length
      && allAccountTokens.every(token => normalizedAccountTokens.includes(token))
    const useFilteredScope = !includesAllOwners || !includesAllAccounts
    onSave?.({
      scope_mode: useFilteredScope ? IMPORTED_CATEGORY_SCOPE_FILTERED : IMPORTED_CATEGORY_SCOPE_ALL,
      owner_ids: useFilteredScope ? normalizedOwnerIds : [],
      unassigned_account_tokens: useFilteredScope ? normalizedAccountTokens : [],
    })
  }

  return (
    <OverlayBackdrop zIndex={1200} tint="rgba(15, 23, 42, 0.34)">
      <FloatingPanel style={{ width: 'min(620px, 100%)' }}>
        <FloatingPanelHeader style={{ padding: '16px 20px' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>{description}</div>
          </div>
        </FloatingPanelHeader>
        <div style={{ padding: 20, display: 'grid', gap: 16 }}>
          <div
            style={{
              display: 'grid',
              gap: 12,
              padding: 14,
              borderRadius: 14,
              border: '1px solid var(--border)',
              background: 'color-mix(in srgb, var(--surface2) 72%, var(--surface))',
            }}
          >
            {ownerChoices.length > 0 ? (
              <div style={{ display: 'grid', gap: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Owners</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {ownerChoices.map(choice => (
                    <label key={choice.key} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={selectedOwnerIds.includes(choice.ownerId)}
                        onChange={() => toggleOwner(choice.ownerId)}
                      />
                      <span style={{ fontSize: 13 }}>{choice.label}</span>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{choice.rowCount} rows</span>
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
            {accountChoices.length > 0 ? (
              <div style={{ display: 'grid', gap: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.05em' }}>Accounts to include</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {accountChoices.map(choice => (
                    <label key={choice.key} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={selectedAccountTokens.includes(choice.token)}
                        onChange={() => toggleAccount(choice.token)}
                      />
                      {/* Show the file's original account label → the account it maps to. Several source
                          labels can resolve to one account, so the mapped name alone reads as duplicates. */}
                      <span style={{ fontSize: 13 }}>
                        {choice.sourceLabel && choice.sourceLabel !== choice.label ? (
                          <>
                            {choice.sourceLabel}
                            <span style={{ color: 'var(--muted)', opacity: 0.7 }}> → </span>
                            <span style={{ color: 'var(--muted)' }}>{choice.label}</span>
                          </>
                        ) : choice.label}
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{choice.rowCount} rows</span>
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
            {ownerChoices.length === 0 && accountChoices.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                No owners or unassigned-account choices are available until the accounts in this import are mapped.
              </div>
            ) : null}
            {ownerChoices.length > 0 || accountChoices.length > 0 ? (
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                Uncheck anything you want to exclude.
              </div>
            ) : null}
          </div>
        </div>
        <DialogActions>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button onClick={handleSave}>Save</Button>
        </DialogActions>
      </FloatingPanel>
    </OverlayBackdrop>
  )
}
