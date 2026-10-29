// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api.js'
import { AppDialog, AppNoticeDialog, Badge, Button, IconButton, Input, InsetPanel, Select, Spinner, Toggle, Tooltip } from '../ui.jsx'
import CategoryPicker from '../CategoryPicker.jsx'
import AmazonAccountPicker from './AmazonAccountPicker.jsx'
import FeatureExplainer from '../../help/FeatureExplainer.jsx'
import { useAppSession } from '../../lib/AppSessionContext.jsx'
import { useUserPreference } from '../../lib/UserPreferencesContext.jsx'
import { isMarketplaceAccountType } from '../../lib/accountTypes.js'
import { AMAZON_IMPORT_ACCOUNT_PREF_KEY, DEMO_IMPORT_DISABLED_MESSAGE } from '../../lib/importExport/constants.js'
import { skippedFileNoticeTitle, skippedFileReason } from '../../lib/importExport/importOutcome.js'
import FileInput from '../FileInput.jsx'
import { PICKER_IDS } from '../../lib/filePicker.js'

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

// The card label and the "Needs mapping" slot are fixed columns, and the badge keeps its slot on a row
// that doesn't show one, so every row's account Select starts at the same x whatever the card is called
// and whatever state it is in. Sized to hold the longest badge without wrapping it.
//
// The list is indented under its heading, the step the category tree uses, so the rows read as belonging
// to it. The widths are what the body has left after that: the label column holds the longest card name
// measured (a network name plus its last-4) without truncating, and the Select keeps more than the
// ~225px its longest option needs.
const CARD_LIST_INDENT = 24
const CARD_LABEL_WIDTH = 190
const CARD_BADGE_WIDTH = 120

// The settings are a two-column form: the field's name on the left, what it is set to on the right. The
// grid is top-aligned because three of the four fields are taller than one line, so each label takes the
// offset that puts it on its own field's first line rather than floating beside the middle of a box.
const FORM_LABEL_WIDTH = 160
const ACCOUNT_FIELD_ID = 'amazon-import-account'
const PROFILE_FIELD_ID = 'amazon-import-profile'
// Each control is sized to what it holds, not to the column: the label column is what lines the fields
// up, and stretching a control past its content only moves its own affordance away from the value. This
// is what the account select's longest option needs; the category picker takes its content's width.
const ACCOUNT_SELECT_WIDTH = 320

const FIELD_LABEL_TYPE = { fontSize: 13, lineHeight: 1.35 }

// Where a `Badge`'s label starts, measured in from the badge's left edge: its 1px border, its 8px left
// padding, the 7px category marker and the 4px gap between marker and text (all in `Badge` /
// `CategoryMarker`, ui.jsx). A caption indented by this starts under the badge's words rather than under
// the badge itself. Its wash reaches back over the padding, so the text lands on the inset, not past it.
const BADGE_TEXT_INSET = 20
const CAPTION_PADDING_X = 8

function FieldLabel({ children, htmlFor, top = 9 }) {
  return (
    <label
      htmlFor={htmlFor}
      style={{ ...FIELD_LABEL_TYPE, fontWeight: 500, color: 'var(--muted)', paddingTop: top }}
    >
      {children}
    </label>
  )
}

// One line of the label's type, to start a field on the label's *second* line. A line rather than a
// measured offset, so it tracks the type instead of a number taken off a screenshot; it is set in the
// label's own metrics because a break is otherwise as tall as whatever cell it sits in. Anyone who
// rewraps the label it aligns with will see this and can decide whether it still belongs.
function LabelLineSpacer() {
  return <div aria-hidden="true" style={FIELD_LABEL_TYPE}><br /></div>
}

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
        {/* The last-4 is what identifies the card, so only the network name gives way when the label is
            too long for the column; the full label is on the title. */}
        <div
          title={formatInstrumentLabel(instrument.last4, instrument.network)}
          style={{
            flex: `0 0 ${CARD_LABEL_WIDTH}px`, minWidth: 0, display: 'flex', gap: 4,
            fontSize: 13, color: 'var(--text)',
          }}
        >
          {(instrument.network || '').trim() ? (
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {instrument.network.trim()}
            </span>
          ) : null}
          <span style={{ flex: '0 0 auto' }}>···{instrument.last4}</span>
        </div>
        <div style={{ flex: `0 0 ${CARD_BADGE_WIDTH}px` }}>
          {instrument.state === 'unmapped' ? <Badge label="Needs mapping" toneKey="pending" /> : null}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Told to fill its cell: left to itself a select takes the width of its widest option, and a
              long account name then drags the row past the dialog and raises a horizontal scrollbar. The
              name clips here but the open dropdown still shows it in full. */}
          <Select
            value={creating ? FUNDING_NEW : value}
            onChange={v => { if (v === FUNDING_NEW) { setCreating(true) } else { setCreating(false); onPick(instrument, v) } }}
            options={accountOptions}
            aria-label={`Account for ${formatInstrumentLabel(instrument.last4, instrument.network)}`}
            disabled={disabled}
            style={{ width: '100%', minWidth: 0 }}
          />
        </div>
      </div>
      {creating && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8, marginLeft: CARD_LABEL_WIDTH + CARD_BADGE_WIDTH + 20 }}>
          <Input value={newName} onChange={setNewName} placeholder="New account name"
            aria-label="New account name" style={{ flex: 1 }} />
          <Button onClick={submitNew} disabled={disabled || !newName.trim()}>Create</Button>
          <Button variant="secondary" onClick={() => { setCreating(false); setNewName('') }}>Cancel</Button>
        </div>
      )}
    </div>
  )
}

// The Amazon import form, opened over the Data Import tab when AZAD order-history files are dropped on
// it (the drop zone recognizes them by their header). Mirrors the CSV import-mapping page: the dropped
// files up top, then the target account + the excluded category for the matched card charge, then a row
// per payment card found in the files (mapped to the account it charges), an "apply my rules" toggle,
// and Import / Cancel. The card mappings + category are global and prefill on the next import; Import
// is gated until the account is chosen and every discovered card has a decision. A finished import is
// handed to the host as `onImported(summary)`, which shows it on its cards in the import history.
export function AmazonImportDialog({ files: droppedFiles, onClose, onImported }) {
  // The backend refuses the import while demo data is loaded, so the tab says so up front rather than after
  // the form is filled in.
  const { demoLoaded } = useAppSession()
  const [accounts, setAccounts] = useState([])
  // Persisted per user so the chosen Amazon account carries over from visit to visit.
  const [accountId, setAccountId] = useUserPreference(AMAZON_IMPORT_ACCOUNT_PREF_KEY, '')
  const [files, setFiles] = useState(droppedFiles)
  const [scan, setScan] = useState(null)            // { instruments, unrecognized_files, ... } | null
  const [skippedFilesAlert, setSkippedFilesAlert] = useState(null)   // skipped-file entries awaiting an OK
  // The saved Amazon sources. Picking one fills in the account and the categorize toggle; the import is
  // stamped with it, which is what groups its card under that source. A drop may name none, which is the
  // form as it always was.
  const [profiles, setProfiles] = useState([])
  const [profileId, setProfileId] = useState('')
  const [scanning, setScanning] = useState(false)
  const [categories, setCategories] = useState([])
  const [fundingCategory, setFundingCategory] = useState(null)
  const [applyCategorization, setApplyCategorization] = useState(true)
  const [busy, setBusy] = useState(false)           // a mapping/category save in flight
  const [loading, setLoading] = useState(false)     // the import itself
  const [error, setError] = useState('')
  const fileInputRef = useRef(null)

  const loadAccounts = useCallback(
    () => api.getAccounts({ include_children: true }).then(setAccounts).catch(() => { }),
    [],
  )
  // Selecting a source *fills the form in*; it does not lock it. The settings are the source's defaults
  // for this drop, and a one-off override here is an answer about this import, not a change to the
  // source — which is edited on the File Sources tab.
  const applyProfile = useCallback((id) => {
    setProfileId(id)
    const profile = profiles.find(p => p.id === id)
    if (!profile) return
    if (profile.account_id) setAccountId(profile.account_id)
    setApplyCategorization(!!profile.apply_categorization)
  }, [profiles, setAccountId])
  useEffect(() => {
    loadAccounts()
    api.getCategories().then(setCategories).catch(() => { })
    api.getAmazonFundingCategory().then(setFundingCategory).catch(() => { })
    api.getAmazonProfiles().then(r => setProfiles(r?.profiles || [])).catch(() => { })
  }, [loadAccounts])

  // Preselect the source whose filename pattern the dropped files match — the one case where the answer
  // is in the drop itself, and the reason the pattern is worth setting. Only an unambiguous match counts
  // (every matched file agreeing on one source); anything else leaves the choice to the user. It runs
  // once per set of files, so a deliberate change of source is not undone on the next scan.
  const autoPickedFor = useRef('')
  useEffect(() => {
    const key = files.map(f => f.name).join('\u0000')
    if (!profiles.length || !files.length || autoPickedFor.current === key) return
    autoPickedFor.current = key
    const matched = new Set()
    for (const file of files) {
      for (const profile of profiles) {
        const pattern = (profile.filename_pattern || '').trim().toLowerCase()
        if (pattern && file.name.toLowerCase().includes(pattern)) matched.add(profile.id)
      }
    }
    if (matched.size === 1) applyProfile([...matched][0])
  }, [files, profiles, applyProfile])

  // Drop a remembered account that no longer exists (deleted, or no longer an Amazon account) once the
  // account list has loaded, so the selector doesn't sit on a stale value.
  useEffect(() => {
    if (!accountId || !accounts.length) return
    if (!accounts.some(a => a.id === accountId && (a.type || '').toLowerCase() === 'amazon')) setAccountId('')
  }, [accounts, accountId, setAccountId])

  // Scan the dropped files for their payment cards whenever the files (or the target account, which
  // affects per-account override resolution) change. Read-only — no ledger changes.
  // A file the scan skipped (its content already seen) gets a must-acknowledge notice whose OK drops it
  // from the selection — so a later rescan can't see (or re-nag about) it.
  const rescan = useCallback((currentFiles, currentAccountId) => {
    if (!currentFiles.length) { setScan(null); return Promise.resolve() }
    setScanning(true)
    return api.scanAmazonFiles(currentFiles, currentAccountId)
      .then(result => {
        setScan(result)
        const skipped = result?.skipped_uploads || []
        if (skipped.length) setSkippedFilesAlert(skipped)
      })
      .catch(e => { setError(e?.message || 'Could not read the files'); setScan(null) })
      .finally(() => setScanning(false))
  }, [])
  useEffect(() => { rescan(files, accountId) }, [files, accountId, rescan])

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
      onImported(await api.importAmazon(files, accountId, applyCategorization, profileId || null))
    } catch (e) {
      setError(e?.message || 'Import failed')
    } finally {
      setLoading(false)
    }
  }

  // The account picker lists Amazon-type accounts only; the funding picker lists the user's non-marketplace
  // accounts (a card charge never lands on an Amazon account), plus Untracked and + New.
  const amazonAccounts = accounts.filter(a => (a.type || '').toLowerCase() === 'amazon')
  // Shown only when there is a source to pick: with none saved, the row would be a control whose only
  // option is the state the form is already in.
  const profileOptions = [
    { value: '', label: 'None — set the options below' },
    ...profiles.map(p => ({ value: p.id, label: p.account_name ? `${p.name} → ${p.account_name}` : p.name })),
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
      help={<FeatureExplainer topic="amazon-funding-sources" placement="bottom-left" />}
      onClose={onClose}
      width="min(640px, 100%)"
      actions={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>Cancel</Button>
          <Tooltip describeTrigger content={importHint}>
            <Button onClick={run} disabled={!canImport}>
              {loading ? 'Importing…' : `Import ${files.length} file${files.length === 1 ? '' : 's'}`}
            </Button>
          </Tooltip>
        </>
      )}
    >
      <div
        style={{
          display: 'grid', gridTemplateColumns: `${FORM_LABEL_WIDTH}px minmax(0, 1fr)`,
          columnGap: 16, rowGap: 16, alignItems: 'start',
        }}
      >
        {/* The panel's own padding is what the label clears, so the first filename sits on its line. */}
        <FieldLabel top={14}>File(s) to import</FieldLabel>
        <div>
          {/* The items file is optional detail for an orders file, so it is often added after the drop. */}
          {/* Tight rows: the list is scanned, not read, and a dozen files at a comfortable gap ran the
              panel past the fold on its own. */}
          <InsetPanel style={{ gap: 2 }}>
            {files.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>No files selected.</div>
            ) : files.map(f => (
              <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {/* Leading, so the controls read as one column against the names rather than sitting out
                    at the panel's edge. The label names the file, since the button no longer follows it. */}
                <IconButton
                  size="compact"
                  title="Remove this file"
                  aria-label={`Remove ${f.name}`}
                  disabled={loading}
                  onClick={() => setFiles(prev => prev.filter(other => other.name !== f.name))}
                  style={{ flex: '0 0 auto' }}
                >
                  ×
                </IconButton>
                <div
                  title={f.name}
                  style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {f.name}
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
              <Button variant="secondary" onClick={() => fileInputRef.current?.click()} disabled={demoLoaded}>Add file(s)</Button>
            </div>
          </InsetPanel>
          {scan?.unrecognized_files?.length ? (
            <div style={{ marginTop: 8, color: '#b45309', fontSize: 12 }}>
              Ignored (not an Amazon export): {scan.unrecognized_files.join(', ')}
            </div>
          ) : null}
        </div>

        {profiles.length ? (
          <>
            <FieldLabel htmlFor={PROFILE_FIELD_ID}>Source</FieldLabel>
            <div>
              <Select
                id={PROFILE_FIELD_ID}
                value={profileId}
                onChange={applyProfile}
                options={profileOptions}
                style={{ width: '100%', maxWidth: ACCOUNT_SELECT_WIDTH }}
              />
            </div>
          </>
        ) : null}

        <FieldLabel htmlFor={ACCOUNT_FIELD_ID}>Import into account</FieldLabel>
        {/* The dialog body stretches its own children; inside a form cell the select has to be told. */}
        <AmazonAccountPicker
          id={ACCOUNT_FIELD_ID}
          accounts={amazonAccounts}
          value={accountId}
          onChange={setAccountId}
          onCreated={loadAccounts}
          onError={setError}
          style={{ width: '100%', maxWidth: ACCOUNT_SELECT_WIDTH }}
        />

        <FieldLabel top={2}>Category for matched card charges</FieldLabel>
        <div>
          {/* The picker sits on "charges", the label's second line. */}
          <LabelLineSpacer />
          {/* Raised above the dialog: the picker portals its dropdown to the body, beneath an AppDialog. */}
          <CategoryPicker
            value={fundingCategory?.category_id}
            categories={categories}
            showSelectedBadge
            panelZIndex={1300}
            style={{ width: 'fit-content', maxWidth: '100%' }}
            onChange={chooseCategory}
            onCategoryCreated={async () => { setCategories(await api.getCategories().catch(() => categories)) }}
          />
          {fundingCategory && !fundingCategory.is_excluded ? (
            <div style={{ color: '#b45309', fontSize: 12, marginTop: 6 }}>
              This category isn’t excluded from totals — Amazon spend may be counted twice. Pick an excluded
              (e.g. Transfers) category.
            </div>
          ) : null}
          {/* Helper text for the control above it, in the app's usual muted caption rather than a panel
              of its own: it belongs to the picker, and a box would set it apart from it. */}
          <p
            style={{
              fontSize: 11.5,
              color: 'var(--muted)',
              lineHeight: 1.45,
              margin: `4px 0 0 ${BADGE_TEXT_INSET - CAPTION_PADDING_X}px`,
              padding: `6px ${CAPTION_PADDING_X}px`,
              // The old panel's fill without its border: the border is what made it a separate object.
              background: 'color-mix(in srgb, var(--surface2) 55%, transparent)',
              borderRadius: 6,
            }}
          >
            Category assigned to the matching <em>AMAZON.COM</em> charges to prevent
            double counting.
          </p>
        </div>

        <FieldLabel top={2}>Categorization</FieldLabel>
        <div>
          <Toggle
            checked={applyCategorization}
            onChange={setApplyCategorization}
            label="Apply my rules to the imported orders"
          />
        </div>
      </div>

      {/* The card list is a table of its own, not one field's value, so it keeps the full width below the
          form rather than sitting in the form's value column. */}
      <div style={{ borderTop: '1px solid var(--border)', marginTop: 22, paddingTop: 16 }}>
        <div style={{ ...mapLabelStyle, marginTop: 0 }}>Payment cards</div>
        <div style={{ marginLeft: CARD_LIST_INDENT }}>
          {scanning && instruments.length === 0 ? (
            <Spinner />
          ) : instruments.length === 0 ? (
            // Cards are parsed from the orders export's `payments` column, so an items-only drop has none
            // to show for a structural reason rather than because the orders were all gift-card funded.
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>
              {scan && !scan.order_count && scan.has_items
                ? 'No payment information: payment information is only in the orders file.'
                : 'No card charges found in these files.'}
            </div>
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
        </div>
      </div>

      {error ? <div style={{ marginTop: 14, color: 'var(--danger)', fontSize: 13 }}>{error}</div> : null}

      <FileInput ref={fileInputRef} pickerId={PICKER_IDS.amazonImport} accept=".csv" multiple hidden
        onChange={e => { addFiles(e.target.files || []); e.target.value = '' }} />

      {skippedFilesAlert ? (
        <AppNoticeDialog
          title={skippedFileNoticeTitle(skippedFilesAlert)}
          description="Files are matched by their content, not their name."
          onClose={() => {
            // Acknowledging drops the flagged files (scan reports names; the list is keyed by name), so
            // nothing already covered lingers in the import list. With none left there is nothing to
            // import, and the form closes.
            const dropped = new Set(skippedFilesAlert.map(s => s.filename))
            const remaining = files.filter(f => !dropped.has(f.name))
            setSkippedFilesAlert(null)
            if (remaining.length) setFiles(remaining)
            else onClose()
          }}
          width="min(560px, 100%)"
        >
          <div style={{ maxHeight: '40vh', overflow: 'auto', fontSize: 13, color: 'var(--text)' }}>
            {skippedFilesAlert.map(skip => (
              <div key={skip.filename} style={{ padding: '3px 0' }}>
                <div>{skip.filename}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{skippedFileReason(skip)}</div>
              </div>
            ))}
          </div>
        </AppNoticeDialog>
      ) : null}
    </AppDialog>
  )
}
