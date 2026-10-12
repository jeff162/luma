// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api.js'
import { AppDialog, AppNoticeDialog, Badge, Button, Input, Select, Spinner, Toggle, Tooltip } from '../ui.jsx'
import CategoryPicker from '../CategoryPicker.jsx'
import FeatureExplainer from '../../help/FeatureExplainer.jsx'
import { useAppSession } from '../../lib/AppSessionContext.jsx'
import { useUserPreference } from '../../lib/UserPreferencesContext.jsx'
import { isMarketplaceAccountType } from '../../lib/accountTypes.js'
import { AMAZON_IMPORT_ACCOUNT_PREF_KEY, DEMO_IMPORT_DISABLED_MESSAGE } from '../../lib/importExport/constants.js'

// Sentinel Select value for the explicit "untracked" state (a card that isn't one of the user's
// accounts). Distinct from '' (not yet decided) and from any real account id.
const FUNDING_UNTRACKED = '__untracked__'

function formatInstrumentLabel(last4, network) {
  const net = (network || '').trim()
  return net ? `${net} ···${last4}` : `···${last4}`
}

// Sentinel Select value: "create a new funding account for this card".
const FUNDING_NEW = '__new_funding_account__'

const mapLabelStyle = { fontSize: 13, color: 'var(--text)', fontWeight: 600, marginTop: 22, marginBottom: 8 }

// One "Account from file" row for a payment card the scan found in the files: the card label → the
// account it charges (an existing account, Untracked, or + New). Mirrors the CSV importer's
// account-mapping rows; the chosen mapping persists to the global funding map (prefilling next time).
function AmazonPaymentSourceRow({ instrument, accountOptions, disabled, onPick, onCreateAccount }) {
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const value = instrument.state === 'untracked' ? FUNDING_UNTRACKED
    : instrument.state === 'mapped' ? (instrument.funding_account_id || '')
    : ''
  const submitNew = async () => {
    const name = newName.trim()
    if (!name) return
    await onCreateAccount(instrument, name)
    setCreating(false); setNewName('')
  }
  return (
    <div style={{ padding: '9px 0', borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: '0 0 auto', minWidth: 150, fontSize: 13, color: 'var(--text)' }}>
          {formatInstrumentLabel(instrument.last4, instrument.network)}
        </div>
        {instrument.state === 'unmapped' ? <Badge label="Needs mapping" toneKey="pending" /> : null}
        <div style={{ flex: 1, minWidth: 0 }}>
          <Select
            value={creating ? FUNDING_NEW : value}
            onChange={v => { if (v === FUNDING_NEW) { setCreating(true) } else { setCreating(false); onPick(instrument, v) } }}
            options={accountOptions}
            aria-label={`Account for ${formatInstrumentLabel(instrument.last4, instrument.network)}`}
            disabled={disabled}
          />
        </div>
      </div>
      {creating && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8, marginLeft: 160 }}>
          <Input value={newName} onChange={setNewName} placeholder="New account name"
            aria-label="New account name" style={{ flex: 1 }} />
          <Button small onClick={submitNew} disabled={disabled || !newName.trim()}>Create</Button>
          <Button small variant="ghost" onClick={() => { setCreating(false); setNewName('') }}>Cancel</Button>
        </div>
      )}
    </div>
  )
}

// The Amazon import form, opened over the File Import tab when AZAD order-history files are dropped on
// it (the drop zone recognizes them by their header). Mirrors the CSV import-mapping page: the dropped
// files up top, then the target account + the excluded category for the matched card charge, then a row
// per payment card found in the files (mapped to the account it charges), an "apply my rules" toggle,
// and Import / Cancel. The card mappings + category are global and prefill on the next import; Import
// is gated until the account is chosen and every discovered card has a decision. A finished import is
// handed to the host as `onImported(summary)`, which shows it on its cards in the import history.
export function AmazonImportDialog({ files: droppedFiles, onClose, onImported }) {
  const NEW_ACCOUNT = '__new__'
  // The backend refuses the import while demo data is loaded, so the tab says so up front rather than after
  // the form is filled in.
  const { demoLoaded } = useAppSession()
  const [accounts, setAccounts] = useState([])
  // Persisted per user so the chosen Amazon account carries over from visit to visit.
  const [accountId, setAccountId] = useUserPreference(AMAZON_IMPORT_ACCOUNT_PREF_KEY, '')
  const [creatingAccount, setCreatingAccount] = useState(false)
  const [newAccountName, setNewAccountName] = useState('Amazon')
  const [savingAccount, setSavingAccount] = useState(false)
  const [files, setFiles] = useState(droppedFiles)
  const [scan, setScan] = useState(null)            // { instruments, unrecognized_files, ... } | null
  const [skippedFilesAlert, setSkippedFilesAlert] = useState(null)   // already-imported names awaiting an OK
  const [scanning, setScanning] = useState(false)
  const [categories, setCategories] = useState([])
  const [fundingCategory, setFundingCategory] = useState(null)
  const [applyCategorization, setApplyCategorization] = useState(true)
  const [busy, setBusy] = useState(false)           // a mapping/category save in flight
  const [loading, setLoading] = useState(false)     // the import itself
  const [error, setError] = useState('')
  const fileInputRef = useRef(null)

  const loadAccounts = useCallback(
    () => api.getAccounts({ include_children: true }).then(setAccounts).catch(() => {}),
    [],
  )
  useEffect(() => {
    loadAccounts()
    api.getCategories().then(setCategories).catch(() => {})
    api.getAmazonFundingCategory().then(setFundingCategory).catch(() => {})
  }, [loadAccounts])

  // Drop a remembered account that no longer exists (deleted, or no longer an Amazon account) once the
  // account list has loaded, so the selector doesn't sit on a stale value.
  useEffect(() => {
    if (!accountId || !accounts.length) return
    if (!accounts.some(a => a.id === accountId && (a.type || '').toLowerCase() === 'amazon')) setAccountId('')
  }, [accounts, accountId, setAccountId])

  // Scan the dropped files for their payment cards whenever the files (or the target account, which
  // affects per-account override resolution) change. Read-only — no ledger changes.
  // Already-imported files (matched by content) get a must-acknowledge notice whose OK drops them from
  // the selection — so a later rescan can't see (or re-nag about) them.
  const rescan = useCallback((currentFiles, currentAccountId) => {
    if (!currentFiles.length) { setScan(null); return Promise.resolve() }
    setScanning(true)
    return api.scanAmazonFiles(currentFiles, currentAccountId)
      .then(result => {
        setScan(result)
        const skipped = result?.already_imported_files || []
        if (skipped.length) setSkippedFilesAlert(skipped)
      })
      .catch(e => { setError(e?.message || 'Could not read the files'); setScan(null) })
      .finally(() => setScanning(false))
  }, [])
  useEffect(() => { rescan(files, accountId) }, [files, accountId, rescan])

  const onAccountChange = (value) => {
    if (value === NEW_ACCOUNT) { setCreatingAccount(true); setAccountId('') }
    else { setCreatingAccount(false); setAccountId(value) }
  }
  const createAccount = async () => {
    const name = newAccountName.trim()
    if (!name) return
    setSavingAccount(true); setError('')
    try {
      const created = await api.createAccount({ name, type: 'amazon' })
      await loadAccounts()
      setAccountId(created.id)
      setCreatingAccount(false)
    } catch (e) {
      setError(e?.message || 'Could not create account')
    } finally {
      setSavingAccount(false)
    }
  }

  const addFiles = (list) => {
    // Snapshot the FileList to a real array *now*, synchronously — the <input>'s live FileList empties
    // the moment we reset `e.target.value = ''`, and the setFiles updater runs later.
    const incoming = Array.from(list)
    setFiles(prev => {
      const byName = new Map(prev.map(f => [f.name, f]))
      for (const f of incoming) byName.set(f.name, f)
      return Array.from(byName.values())
    })
  }

  // Map / untrack a payment card → persist to the global funding map, then re-scan to reflect.
  const pickPaymentSource = async (instrument, value) => {
    if (!value) return
    setBusy(true)
    try {
      const body = { last4: instrument.last4, network: instrument.network || null }
      if (value === FUNDING_UNTRACKED) body.untracked = true
      else body.funding_account_id = value
      await api.saveAmazonFundingSource(body)
      await rescan(files, accountId)
    } finally { setBusy(false) }
  }
  const createFundingAccount = async (instrument, name) => {
    setBusy(true)
    try {
      const created = await api.createAccount({ name, type: 'credit' })
      await loadAccounts()
      await api.saveAmazonFundingSource({ last4: instrument.last4, network: instrument.network || null, funding_account_id: created.id })
      await rescan(files, accountId)
    } finally { setBusy(false) }
  }

  const chooseCategory = async (categoryId) => {
    if (!categoryId) return
    setBusy(true)
    try { setFundingCategory(await api.setAmazonFundingCategory(categoryId)) } finally { setBusy(false) }
  }

  const run = async () => {
    setError(''); setLoading(true)
    try {
      onImported(await api.importAmazon(files, accountId, applyCategorization))
    } catch (e) {
      setError(e?.message || 'Import failed')
    } finally {
      setLoading(false)
    }
  }

  // The account picker lists Amazon-type accounts only; the funding picker lists the user's non-marketplace
  // accounts (a card charge never lands on an Amazon account), plus Untracked and + New.
  const amazonAccounts = accounts.filter(a => (a.type || '').toLowerCase() === 'amazon')
  const amazonAccountOptions = [
    { value: '', label: amazonAccounts.length ? 'Select an account…' : 'No Amazon account yet — create one →' },
    ...amazonAccounts.map(a => ({ value: a.id, label: a.display_name || a.name })),
    { value: NEW_ACCOUNT, label: '＋ New Amazon account…' },
  ]
  const fundingAccountOptions = [
    { value: '', label: '— Select —' },
    ...accounts.filter(a => !isMarketplaceAccountType(a.type)).map(a => ({ value: a.id, label: a.display_name || a.name })),
    { value: FUNDING_UNTRACKED, label: 'Untracked — not my account' },
    { value: FUNDING_NEW, label: '＋ New account…' },
  ]

  const instruments = scan?.instruments || []
  const unresolved = instruments.filter(i => i.state === 'unmapped')
  const canImport = accountId && files.length > 0 && unresolved.length === 0 && !loading && !busy && !demoLoaded
  const importHint = demoLoaded ? DEMO_IMPORT_DISABLED_MESSAGE
    : loading || canImport || files.length === 0 ? ''
    : !accountId ? 'Choose an account to import into'
    : unresolved.length ? `Map the card ${formatInstrumentLabel(unresolved[0].last4, unresolved[0].network)} (or mark it untracked)`
    : ''

  return (
    <AppDialog
      title="Import Amazon orders"
      onClose={onClose}
      width="min(640px, 100%)"
      actions={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>Cancel</Button>
          <Tooltip content={importHint}>
            <Button onClick={run} disabled={!canImport}>
              {loading ? 'Importing…' : `Import ${files.length} file${files.length === 1 ? '' : 's'}`}
            </Button>
          </Tooltip>
        </>
      )}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <FeatureExplainer topic="amazon-funding-sources" placement="bottom-left" />
        <div style={{ ...mapLabelStyle, margin: 0 }}>File(s) to import</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
        {files.map(f => (
          <div key={f.name} style={{ fontSize: 13, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>
        ))}
      </div>
      {/* The items file is optional detail for an orders file, so it is often added after the drop. */}
      <div style={{ marginTop: 8 }}>
        <Button small variant="ghost" onClick={() => fileInputRef.current?.click()} disabled={demoLoaded}>Add file(s)</Button>
      </div>
      {scan?.unrecognized_files?.length ? (
        <div style={{ marginTop: 8, color: '#b45309', fontSize: 12 }}>
          Ignored (not an Amazon export): {scan.unrecognized_files.join(', ')}
        </div>
      ) : null}

      <div style={mapLabelStyle}>Import into account</div>
      <Select value={creatingAccount ? NEW_ACCOUNT : accountId} onChange={onAccountChange} options={amazonAccountOptions} />
      {creatingAccount && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <Input value={newAccountName} onChange={setNewAccountName} placeholder="Account name"
            aria-label="New account name" style={{ flex: 1 }} />
          <Button small onClick={createAccount} disabled={savingAccount || !newAccountName.trim()}>
            {savingAccount ? 'Creating…' : 'Create'}
          </Button>
          <Button small variant="ghost" onClick={() => { setCreatingAccount(false); setNewAccountName('Amazon') }}>
            Cancel
          </Button>
        </div>
      )}

      <div style={mapLabelStyle}>Category for matched card charges</div>
      <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.5, margin: '0 0 6px' }}>
        The matching <strong>AMAZON.COM</strong> charge is moved into this (excluded) category so Amazon
        spend counts once. Changes apply to future imports too.
      </p>
      {/* Raised above the dialog: the picker portals its dropdown to the body, beneath an AppDialog. */}
      <CategoryPicker
        value={fundingCategory?.category_id}
        categories={categories}
        showSelectedBadge
        panelZIndex={1300}
        onChange={chooseCategory}
        onCategoryCreated={async () => { setCategories(await api.getCategories().catch(() => categories)) }}
      />
      {fundingCategory && !fundingCategory.is_excluded ? (
        <div style={{ color: '#b45309', fontSize: 12, marginTop: 6 }}>
          This category isn’t excluded from totals — Amazon spend may be counted twice. Pick an excluded
          (e.g. Transfers) category.
        </div>
      ) : null}

      <div style={mapLabelStyle}>Payment cards in these files</div>
      {scanning && instruments.length === 0 ? (
        <Spinner />
      ) : instruments.length === 0 ? (
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>No card charges found in these files.</div>
      ) : (
        <div>
          {instruments.map(inst => (
            <AmazonPaymentSourceRow
              key={`${inst.last4}|${inst.network || ''}`}
              instrument={inst}
              accountOptions={fundingAccountOptions}
              disabled={busy || loading}
              onPick={pickPaymentSource}
              onCreateAccount={createFundingAccount}
            />
          ))}
        </div>
      )}

      <div style={{ marginTop: 20 }}>
        <Toggle
          checked={applyCategorization}
          onChange={setApplyCategorization}
          label="Apply my categorization rules to the imported orders"
        />
      </div>

      {error ? <div style={{ marginTop: 14, color: 'var(--danger)', fontSize: 13 }}>{error}</div> : null}

      <input ref={fileInputRef} type="file" accept=".csv" multiple hidden
        onChange={e => { addFiles(e.target.files || []); e.target.value = '' }} />

      {skippedFilesAlert ? (
        <AppNoticeDialog
          title={`${skippedFilesAlert.length} file${skippedFilesAlert.length === 1 ? ' was' : 's were'} already imported`}
          description="Identical content was imported before (matched by file content, not name), so these will be removed from the selection — their existing file cards still cover them."
          onClose={() => {
            // Acknowledging drops the flagged files (scan reports names; the list is keyed by name), so
            // nothing already imported lingers in the import list. With none left there is nothing to
            // import, and the form closes.
            const dropped = new Set(skippedFilesAlert)
            const remaining = files.filter(f => !dropped.has(f.name))
            setSkippedFilesAlert(null)
            if (remaining.length) setFiles(remaining)
            else onClose()
          }}
          width="min(560px, 100%)"
        >
          <div style={{ maxHeight: '40vh', overflow: 'auto', fontSize: 13, color: 'var(--text)' }}>
            {skippedFilesAlert.map(name => <div key={name} style={{ padding: '2px 0' }}>{name}</div>)}
          </div>
        </AppNoticeDialog>
      ) : null}
    </AppDialog>
  )
}
