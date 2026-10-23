// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The "Account from source → Maps To → Skip" grid, shared by every surface that maps a source's accounts
// onto Luma's: the CSV import screen, a connection's mapping dialog, and the data-source editor.
//
// One component because the three are the same interaction on purpose, and two pasted copies had already
// started to differ in the details (which accounts the picker offered, what Skip did to the rest of the
// row). The primary question is "which account?" — one select of existing accounts, a `+New` beside it,
// and a Skip checkbox — with *grouping* treated as a refinement behind
// `PossibleAccountMatchChooserDialog`, surfaced as a chip. Grouping is a subtlety most mappings never
// need, so it is not a choice every row has to make.
//
// The grid owns the row interaction and the chooser; the caller owns the entries. Each row's `entry` is
// the shape `{ accountId, createNew, newName, newType, groupWithAccountId, skip, distinctFromAccountIds,
// materializedAccountId, missingAccountId }`, and every change arrives as `onUpdate(key, patch)` for the
// caller to merge. `missingAccountId` is a saved mapping to an account that no longer exists: the row
// reads as undecided, and its × is still offered so the mapping can be cleared.
// What differs between surfaces is passed in rather than branched on here: what a row says beneath its
// label (`details`), a row the file has already delivered (`lockedNote`), what a skipped row reads as
// (`skipNote`), and new accounts other rows are creating (`inFlightOptions`).

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Select } from '../ui.jsx'
import { PossibleAccountMatchChooserDialog } from './importConfirmDialogs.jsx'
import AccountMatchSelect from './AccountMatchSelect.jsx'
import {
  getAccountMatchLabel,
  guessNewAccountTypeFromName,
  selectableAccountOptions,
} from '../../lib/importExport/importAccountMatching.js'
import { GENERIC_IMPORT_ACCOUNT_TYPES, isMarketplaceAccountType } from '../../lib/accountTypes.js'

const GRID = '1fr 16px 240px 52px'

const inputStyle = {
  width: '100%', background: 'var(--surface2)', color: 'var(--text)',
  borderRadius: 6, padding: '4px 6px', fontSize: 12, outline: 'none',
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
const mutedNoteStyle = { fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }

export default function AccountMappingGrid({
  // The column heading naming where the values come from ("Account from file").
  sourceHeading,
  // `[{ key, label, title?, details?, entry, candidates?, suggestion?, newNameDefault?, lockedNote?,
  // skipNote? }]`. `candidates` / `suggestion` come from `findAccountMatchCandidates` /
  // `findLikelyAccountMatch`; the row never re-derives the second from the first, because "chip-worthy"
  // is stricter than "the list has one entry".
  rows,
  accounts,
  onUpdate,
  // Prefix for the controls' `name` attributes, so each surface's fields are addressable on its own.
  namePrefix,
  // Accounts another row of the same import is creating (`[{ value, label, type }]`). Only the CSV import
  // has them: a connection's rows cannot create an account for each other.
  inFlightOptions = [],
  skipTitle,
  // Horizontal row padding. A grid on its own card insets its rows; one inside a dialog body sits in the
  // dialog's padding already, and the card's inset there would indent it further than the card's grid.
  padX = 14,
  // A grid in a scrolling dialog body keeps its column labels in view; the header is then opaque so rows
  // cannot show through it.
  stickyHeader = false,
}) {
  const [chooser, setChooser] = useState(null)

  // Marketplace accounts (Amazon, …) are filled by their own importer, never by mapping a source onto
  // them, so no row offers them.
  const selectableAccounts = useMemo(
    () => (accounts || []).filter(a => !isMarketplaceAccountType(a.type)),
    [accounts],
  )
  const accountsById = useMemo(() => new Map((accounts || []).map(a => [a.id, a])), [accounts])
  const rowsByKey = useMemo(() => new Map((rows || []).map(row => [row.key, row])), [rows])

  // A question about a row that has gone, or whose candidates have all been removed underneath it, has
  // nothing left to answer. `some`, not `every`: an account deleted under the dialog drops out of the
  // question without cancelling one the remaining candidates can still answer.
  useEffect(() => {
    if (!chooser) return
    const targetStillExists = chooser.candidates.some(candidate => accountsById.has(candidate.id))
    if (!rowsByKey.has(chooser.key) || !targetStillExists) setChooser(null)
  }, [chooser, rowsByKey, accountsById])

  // Opened with the whole candidate set, not one account: the dialog is where those are shown, and
  // "Keep separate" asserts distinctness from all of them. Re-entering to revisit an existing grouping
  // passes the single account it is about, which arrives as a one-entry list and pre-selects.
  function openChooser(row, targets) {
    const candidates = (Array.isArray(targets) ? targets : [targets]).filter(Boolean)
    if (!candidates.length) return
    setChooser({
      key: row.key,
      csvValue: row.label,
      candidates: candidates.map(target => ({
        id: target.id,
        label: getAccountMatchLabel(target) || target.name || row.label,
        institution: target.institution || '',
      })),
    })
  }

  // `selectedId` is which candidate the two relationship answers act on; `keep_separate` ignores it and
  // reads the whole list instead, because declining is an answer about all of them.
  function applyChoice(choice, selectedId) {
    const pending = chooser
    setChooser(null)
    const row = pending ? rowsByKey.get(pending.key) : null
    if (!row) return
    const entry = row.entry
    const newName = entry.newName || row.newNameDefault || row.label
    if (choice === 'keep_separate') {
      // A plain new account, and the one branch that records an *answer* rather than a relationship: the
      // user has looked at both names and said they are different accounts, which is exactly the
      // assertion the cross-account duplicate sweep needs. Discarding it meant the same question came
      // back one flagged transaction at a time once the rows landed.
      onUpdate(row.key, {
        accountId: '',
        createNew: true,
        newName,
        newType: entry.newType || guessNewAccountTypeFromName(row.label),
        groupWithAccountId: '',
        skip: false,
        distinctFromAccountIds: pending.candidates.map(c => c.id),
      })
      return
    }
    const target = accountsById.get(selectedId)
    if (!target) return
    if (choice === 'map_existing') {
      onUpdate(row.key, {
        accountId: target.id,
        createNew: false,
        newName: target.name || row.label,
        newType: target.type || entry.newType || 'depository',
        groupWithAccountId: '',
        skip: false,
        distinctFromAccountIds: [],
      })
    } else if (choice === 'group_with_existing') {
      onUpdate(row.key, {
        accountId: '',
        createNew: true,
        newName,
        newType: entry.newType || target.type || 'depository',
        groupWithAccountId: target.id,
        skip: false,
        distinctFromAccountIds: [],
      })
    }
  }

  return (
    <>
      <div style={{
        display: 'grid', gridTemplateColumns: GRID,
        gap: 12, padding: `6px ${padX}px`, fontSize: 11, fontWeight: 600, color: 'var(--muted)',
        borderBottom: '1px solid var(--border)',
        ...(stickyHeader
          ? { position: 'sticky', top: 0, zIndex: 1, background: 'var(--surface)' }
          : { background: 'var(--surface2)' }),
      }}>
        <span>{sourceHeading}</span>
        <span />
        <span>Maps To</span>
        <span style={{ textAlign: 'center' }}>Skip</span>
      </div>

      {(rows || []).map(row => {
        const { key, label, entry } = row
        const update = patch => onUpdate(key, patch)
        const newNameDefault = row.newNameDefault || label
        const candidates = row.candidates || []
        const suggestion = row.suggestion || null
        const suggestionLabel = getAccountMatchLabel(suggestion) || suggestion?.name || ''
        const relationshipTarget = entry.groupWithAccountId ? accountsById.get(entry.groupWithAccountId) : null
        const relationshipLabel = getAccountMatchLabel(relationshipTarget) || relationshipTarget?.name || ''
        const materialized = entry.materializedAccountId ? accountsById.get(entry.materializedAccountId) : null
        const nameTaken = (accounts || []).some(
          a => a.name.toLowerCase() === String(entry.newName || '').trim().toLowerCase(),
        )
        const clearMapping = () => update({
          accountId: '',
          createNew: false,
          newName: newNameDefault,
          groupWithAccountId: '',
        })
        const cancelNew = () => update({ createNew: false, accountId: '', groupWithAccountId: '' })

        return (
          <div key={key} style={{
            display: 'grid', gridTemplateColumns: GRID,
            gap: 12, padding: `7px ${padX}px`, alignItems: 'center',
            borderBottom: '1px solid var(--border)',
            opacity: row.lockedNote ? 0.5 : (entry.skip ? 0.45 : 1),
          }}>
            <div style={{ minWidth: 0 }}>
              <div
                style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={row.title || label}
              >
                {label}
              </div>
              {row.details}
            </div>

            <span style={{ color: 'var(--muted)', textAlign: 'center', fontSize: 11 }}>→</span>

            {row.lockedNote ? (
              <span style={mutedNoteStyle}>{row.lockedNote}</span>
            ) : entry.skip ? (
              <span style={mutedNoteStyle}>{row.skipNote || 'not imported'}</span>
            ) : !entry.createNew ? (
              <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
                  <AccountMatchSelect
                    name={`${namePrefix}-target-${key}`}
                    value={entry.accountId}
                    // Per row, not once for the grid: the merged child a list carries is the one THIS
                    // row's mapping is on, so two rows can offer different lists.
                    options={selectableAccountOptions(selectableAccounts, entry.accountId)}
                    candidates={candidates}
                    accountsById={accountsById}
                    inFlightOptions={inFlightOptions}
                    // Sharing a new account another row is creating. The row does not reference that
                    // row — it independently declares the same name, which the importer merges by name,
                    // so changing the other row later cannot dangle this one.
                    onSelectInFlight={option => update({
                      accountId: '',
                      createNew: true,
                      newName: option.value,
                      newType: option.type || guessNewAccountTypeFromName(label),
                      groupWithAccountId: '',
                    })}
                    // Picking from the list maps to it. That is the whole interaction — the relationship
                    // question belongs to `+New`, which is the path where a second question remains.
                    onSelectAccount={a => update({ accountId: a.id, createNew: false, groupWithAccountId: '' })}
                    onClear={clearMapping}
                  />
                  {entry.accountId || entry.missingAccountId ? (
                    <button type="button" onClick={clearMapping} style={iconButtonStyle} aria-label={`Clear the mapping for ${label}`}>
                      ×
                    </button>
                  ) : (
                    <button
                      type="button"
                      // With possible matches, ask before creating: the dialog is where they are shown,
                      // which is what lets "Keep separate" record an assertion about them. With none
                      // there is nothing to show and nothing to assert, so this stays a one-press create.
                      onClick={() => {
                        if (candidates.length) { openChooser(row, candidates); return }
                        update({
                          createNew: true,
                          newName: newNameDefault,
                          newType: entry.newType || guessNewAccountTypeFromName(label),
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
                    // The chip maps; it does not ask. Accepting a suggestion is the one-click path, and
                    // the relationship question belongs to `+New`, where creating a second account for
                    // something Luma may already hold is what deserves the second look.
                    onClick={() => update({
                      accountId: suggestion.id,
                      createNew: false,
                      newName: suggestion.name || label,
                      newType: suggestion.type || entry.newType || 'depository',
                      groupWithAccountId: '',
                      skip: false,
                    })}
                    style={{ ...chipStyle, justifySelf: 'end' }}
                    title={`Map to ${suggestionLabel}`}
                  >
                    Possible match: {suggestionLabel}
                  </button>
                ) : null}
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
                {materialized ? (
                  // Already created by an earlier save. Name/type fields here would offer edits the
                  // mapping call ignores (it only names an account it is creating), so the row states
                  // what exists and keeps the relationship editable.
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
                    <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {materialized.name}{materialized.mask ? ` ···${materialized.mask}` : ''}
                    </span>
                    <button type="button" onClick={cancelNew} style={iconButtonStyle} aria-label="Map to a different account instead">
                      ×
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center', minWidth: 0, flexWrap: 'nowrap' }}>
                    <div style={{ width: 132, maxWidth: '100%' }}>
                      <input
                        name={`${namePrefix}-name-${key}`}
                        value={entry.newName}
                        onChange={e => update({ newName: e.target.value })}
                        placeholder="Name"
                        style={{ ...inputStyle, border: `1px solid ${nameTaken ? 'var(--danger)' : 'var(--accent)'}` }}
                      />
                      {nameTaken ? (
                        <div style={{ fontSize: 10, color: 'var(--danger)', marginTop: 2 }}>
                          Name already exists — select it instead
                        </div>
                      ) : null}
                    </div>
                    <Select
                      name={`${namePrefix}-type-${key}`}
                      value={entry.newType}
                      onChange={v => update({ newType: v })}
                      options={[
                        { value: '', label: '— Type —' },
                        ...GENERIC_IMPORT_ACCOUNT_TYPES.map(o => ({ value: o.value, label: o.shortLabel })),
                      ]}
                      style={{ width: 88, fontSize: 11, padding: '4px 5px' }}
                    />
                    <button
                      type="button"
                      onClick={cancelNew}
                      style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 13, padding: 2, flexShrink: 0 }}
                      aria-label="Cancel creating a new account"
                    >✕</button>
                  </div>
                )}
                {relationshipTarget && relationshipLabel ? (
                  <button
                    type="button"
                    onClick={() => openChooser(row, [relationshipTarget])}
                    style={chipStyle}
                    title={`Change how this relates to ${relationshipLabel}`}
                  >
                    Grouped with {relationshipLabel}
                  </button>
                ) : null}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'center' }}>
              {row.lockedNote ? (
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>—</span>
              ) : (
                <input
                  name={`${namePrefix}-skip-${key}`}
                  type="checkbox"
                  checked={!!entry.skip}
                  // The rest of the row is kept, so unticking returns the choice it held. Every reader
                  // checks `skip` first, so a kept field never turns a skip into an import.
                  onChange={e => update({ skip: e.target.checked })}
                  aria-label={`Don't import ${label}`}
                  title={skipTitle}
                  style={{ width: 15, height: 15, cursor: 'pointer', accentColor: 'var(--accent)' }}
                />
              )}
            </div>
          </div>
        )
      })}

      {/* Portaled: the grid sits inside cards and dialogs, and `AppDialog` renders where it is mounted. */}
      {chooser ? createPortal(
        <PossibleAccountMatchChooserDialog
          pending={chooser}
          onSelect={applyChoice}
          onCancel={() => setChooser(null)}
        />,
        document.body,
      ) : null}
    </>
  )
}
