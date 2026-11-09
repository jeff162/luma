// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api.js'
import { useSyncStatus } from '../../contexts/SyncStatusContext.jsx'
import { rosterCardIds } from '../../lib/syncRoster.js'
import { Card, Button, Spinner, Select, Input, PasswordInput, Tooltip, AppDialog, AppConfirmDialog, AppNoticeDialog, OverlayBackdrop, IconButton, LinkButton } from '../ui.jsx'
import SectionCard from '../SectionCard.jsx'
import { HoverLines, LastSyncSummary, LastSyncedLine, StatusPill } from './ConnectionStatus.jsx'
import { ConnectionSyncLogDialog } from './ConnectionSyncLogDialog.jsx'
import { useBatchDetailPanels } from '../importExport/useBatchDetailPanels.jsx'
import { useAccountDetailPanels } from '../accounts/useAccountDetailPanels.jsx'
import { EXISTING_SECRET_PROPS, NO_AUTOFILL_PROPS } from '../../lib/sensitiveFields.js'
import { VaultSettingsDialog } from '../VaultSettingsDialog.jsx'
import { VaultRecoveryDialog } from '../VaultRecoveryDialog.jsx'
import FeatureExplainer from '../../help/FeatureExplainer.jsx'
import { useVaultPasskeyUnlock, VAULT_PASSKEY_LABEL } from '../../lib/useVaultPasskeyUnlock.js'
import {
  connectionAccountsLabel, connectionProviderLabel as providerLabel, lastSyncReportCards,
  providerConnectionStates,
  providerSummaryLine, relinkCandidates,
} from '../../lib/connectionSummary.js'
import ConnectionAccountMapDialog from '../accounts/ConnectionAccountMapDialog.jsx'
import { ActionMenu, ActionMenuButton } from '../ActionMenu.jsx'
import { formatTimestamp } from '../../lib/utils.js'
import { connectionsAllowanceLines } from '../../lib/requestAllowance.js'
import { useAppSession } from '../../lib/AppSessionContext.jsx'
import { useUserPreference } from '../../lib/UserPreferencesContext.jsx'
import { useVaultGateContext } from '../../contexts/VaultGateContext.jsx'
import { useConnectionOperations } from '../../lib/useConnectionOperations.js'
import { IMPORT_CONFIG_MAX_WIDTH } from '../../lib/importExport/constants.js'
import { LABEL_PILL_COLORS } from '../pillStyles.js'

// --- Data-source connections --------------------------------------------------------------------
//
// The Import page's Connections tab: everything about a data connection. Across the top, the routine
// pull for every connection and the whole sync log; below, one card per supported aggregator, plus the
// vault affordance the cards depend on.
// Provider *configuration* (the app credential) lives here, not in Settings; the app secret is vaulted,
// so connecting/syncing needs the vault unlocked, and — on a networked bind — HTTPS. The layout is
// provider-generic: a card is drawn from what each provider declares, not from its name.

// The badge marks the environment worth *remarking on*, which is never the expected one. Sandbox earns it
// because it is the state that makes a working app look broken — the user's real accounts are absent and
// every balance is invented, and nothing else on the card would say why. Production is the steady state,
// and it used to wear a red live-money tone: an alarm colour on the one configuration that is correct,
// which both misreads as an error and spends the colour this UI reserves for actual failures. So
// Production renders nothing at all, and so does a provider with no test mode to be in (`env` null) —
// a badge there would imply a sandbox/production distinction it does not have. Anything unrecognized
// still renders, since a value we cannot place is exactly the one not to hide.
function EnvBadge({ env }) {
  if (!env || env === 'production') return null
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', ...LABEL_PILL_COLORS,
      borderRadius: 99, padding: '2px 9px', fontSize: 11, fontWeight: 600, textTransform: 'capitalize',
      whiteSpace: 'nowrap',
    }}>
      {env}
    </span>
  )
}

function ProviderConfigDialog({ provider, initial, onSave, onClose, ensureVault }) {
  const [clientId, setClientId] = useState(initial?.client_id || '')
  const [secret, setSecret] = useState('')
  const [env, setEnv] = useState(initial?.env || 'sandbox')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // What Show fetched, kept so an untouched reveal doesn't save the same secret back and re-encrypt it.
  const [revealedSecret, setRevealedSecret] = useState(null)
  const hasSecret = !!initial?.has_secret

  async function loadStoredSecret() {
    const res = await api.getProviderSecret(provider)
    setSecret(res.secret || '')
    setRevealedSecret(res.secret || '')
  }

  // The stored secret is write-only everywhere else, so revealing it means fetching it — a diagnostic for
  // checking the saved value against the provider's dashboard. Throwing keeps the field hidden rather than
  // showing an empty box that would read as "the secret is blank".
  //
  // The dialog opens only with the vault unlocked, so the fetch normally just works. PasswordInput holds
  // the field hidden until this resolves, which is what lets a re-prompt reveal the secret on the same
  // press of Show. A declined prompt throws, leaving the field hidden and silent.
  async function revealStoredSecret() {
    if (secret) return               // already showing something typed (or previously revealed)
    if (!hasSecret) return
    setError('')
    try {
      await loadStoredSecret()
    } catch (e) {
      let failure = e
      // A 423 here means the server dropped the key while the dialog was open (restart or idle
      // timeout) — the gate arriving late. Re-prompt and retry once, so this still costs a single press
      // of Show.
      if (failure.status === 423 && await ensureVault({ force: true })) {
        try {
          await loadStoredSecret()
          return
        } catch (retryFailure) { failure = retryFailure }
      }
      setError(failure.status === 423
        ? 'Unlock the vault to view the stored secret.'
        : (failure.message || 'Could not read the stored secret'))
      throw failure
    }
  }

  async function submit() {
    setSaving(true)
    setError('')
    // A blank secret field leaves the stored secret unchanged (write-only), so an edit that only
    // changes client_id/env never forces re-entering the secret. A revealed-but-unedited secret is
    // the same case: it is the stored value, so re-sending it would only churn the ciphertext.
    const payload = { client_id: clientId, env }
    if (secret && secret !== revealedSecret) payload.secret = secret
    try {
      await onSave(payload)
    } catch (e) {
      let failure = e
      if (failure.status === 423 && await ensureVault({ force: true })) {
        try {
          await onSave(payload)
          return
        } catch (retryFailure) { failure = retryFailure }
      }
      setError(failure.message || 'Could not save credentials')
      setSaving(false)
    }
  }

  return (
    <AppDialog
      title={`Configure ${providerLabel(provider)}`}
      description="These app credentials identify this app to the provider. The secret is stored in the encrypted vault."
      onClose={onClose}
      width="min(520px, 100%)"
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'grid', gap: 4, fontSize: 13 }}>
          <span style={{ color: 'var(--muted)' }}>Client ID</span>
          <Input value={clientId} onChange={setClientId} placeholder="Provider client ID" />
        </div>
        <div style={{ display: 'grid', gap: 4, fontSize: 13 }}>
          <span style={{ color: 'var(--muted)' }}>Secret</span>
          <PasswordInput value={secret} onChange={setSecret}
            placeholder={hasSecret ? '•••••••• (leave blank to keep)' : 'Provider secret'}
            onReveal={hasSecret ? revealStoredSecret : undefined}
            {...EXISTING_SECRET_PROPS} />
          {hasSecret ? (
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>
              Show reveals the stored secret — for checking it against the provider’s dashboard. Leave the
              field untouched to keep it.
            </span>
          ) : null}
        </div>
        <div style={{ display: 'grid', gap: 4, fontSize: 13 }}>
          <span style={{ color: 'var(--muted)' }}>Environment</span>
          <Select value={env} onChange={setEnv} options={[
            { value: 'sandbox', label: 'Sandbox' },
            { value: 'production', label: 'Production' },
          ]} />
        </div>
        {error ? <div style={{ fontSize: 13, color: '#dc2626' }}>{error}</div> : null}
      </div>
    </AppDialog>
  )
}

// How far back a new connection pulls on its first sync. Shared by the connect dialog and the
// Plaid card so the two cannot drift apart. "All available history" is bounded by whatever the provider
// itself will return, which for a cursor provider is its published cap and for a walking provider is where
// its history actually runs out.
// Why connecting is refused, and the two ways out. The server refuses the same request with the same
// reasoning (`backend/transport.py`), so this is the answer arriving before the vault prompt and the
// provider's own screens, not a second rule.
const UNPROTECTED_LINK_NOTICE = {
  title: 'Not available over plain HTTP from another device',
  description: 'Connecting sends a data provider\u2019s secret to the server, and this browser reaches the server over the network without HTTPS. Connect from a browser on the computer the server runs on, or set up HTTPS first.',
}

const HISTORY_DEPTH_OPTIONS = [
  { value: '0', label: 'All available history' },
  { value: '730', label: 'Last 2 years' },
  { value: '365', label: 'Last year' },
  { value: '90', label: 'Last 90 days' },
  { value: '30', label: 'Last 30 days' },
]

const HISTORY_DEPTH_TITLE = "How far back this connection pulls on its first sync. Saved as your default for future connections. To pull older history for an existing connection, use Fetch more history in its ⋯ menu."

// Connect a provider whose authorization is a value the user pastes rather than a widget that opens.
// Everything shown is driven by the provider's `connect_spec` — label, help link, placeholder — so adding
// another token-style provider needs no change here.
//
// The history depth is asked for HERE rather than on the provider's card, because for a provider with no
// app-level credential the card does not exist until a connection does — so a setting living there could
// not be reached at the one moment it applies, and every first connection silently took the default.
function TokenConnectDialog({ provider, spec, historyDays, onConnect, onClose,
  relinkCandidates = [], describeConnection }) {
  const [token, setToken] = useState('')
  // '' = a new connection. Asked here, and answered *before* the token is submitted, because the
  // authorization behind it is single-use: once the provider has issued a credential there is no second
  // attempt to act on a different answer, so the question cannot wait until the new handle is known.
  const [adopt, setAdopt] = useState('')
  // Held locally and handed to `onConnect`, rather than written straight to the shared preference: the
  // connect that follows must use exactly what is on screen, and reading it back from state the click
  // just scheduled is the kind of ordering question worth not having.
  const [days, setDays] = useState(historyDays)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    setConnecting(true)
    setError('')
    try {
      await onConnect(token.trim(), days, adopt || null)
    } catch (e) {
      // Staying open with the message is deliberate: these tokens are single-use, and the most common
      // failure is a token already claimed — which the user resolves by pasting a fresh one right here.
      setError(e.message || 'Could not connect')
      setConnecting(false)
    }
  }

  return (
    <AppDialog
      title={`Connect ${providerLabel(provider)}`}
      description={`Paste the ${(spec?.label || 'token').toLowerCase()} to link accounts. It is exchanged for a credential that is stored in the encrypted vault.`}
      onClose={onClose}
      width="min(560px, 100%)"
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={connecting || !token.trim()}>
            {connecting ? 'Connecting…' : 'Connect'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'grid', gap: 4, fontSize: 13 }}>
          <span style={{ color: 'var(--muted)' }}>{spec?.label || 'Token'}</span>
          {/* A plain Input rather than a masked or multiline field: a setup token is one long opaque
              string, it is single-use and short-lived, and the user needs to see that the paste landed
              intact — the common failure here is a truncated copy. */}
          <Input
            value={token}
            onChange={setToken}
            placeholder={spec?.placeholder || ''}
            autoFocus
            {...NO_AUTOFILL_PROPS}
          />
          {spec?.hint ? (
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>{spec.hint}</span>
          ) : null}
        </div>
        {spec?.help_url ? (
          <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, margin: 0 }}>
            Get one at{' '}
            <a href={spec.help_url} target="_blank" rel="noreferrer noopener">{spec.help_url}</a>.
          </p>
        ) : null}
        {/* Only for a provider that issues a fresh handle per authorization, and only once it has
            something to replace. Everywhere else the provider's own handle answers this, and asking
            would be a question with one possible answer. */}
        {relinkCandidates.length > 0 ? (
          <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
            <span style={{ color: 'var(--muted)' }}>What is this connecting?</span>
            <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, margin: 0 }}>
              {providerLabel(provider)} identifies a connection by its credential, so a new one looks like
              a new connection. Say which this is: replacing keeps that connection’s accounts, settings and
              the history it has already fetched, instead of starting a second one alongside it.
            </p>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input type="radio" name="relink-target" checked={adopt === ''}
                onChange={() => setAdopt('')} style={{ marginTop: 3 }} />
              <span>A new connection</span>
            </label>
            {relinkCandidates.map(c => {
              const detail = describeConnection?.(c)
              return (
                <label key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <input type="radio" name="relink-target" checked={adopt === c.id}
                    onChange={() => setAdopt(c.id)} style={{ marginTop: 3 }} />
                  <span>
                    Replaces {c.institution || 'an existing connection'}
                    {c.reauth_required ? (
                      <span style={{ color: 'var(--warning)' }}> — needs reconnecting</span>
                    ) : null}
                    {/* The institution is the same string for every connection of a provider that spans
                        several banks, so the accounts are what actually tell two of them apart. */}
                    {detail ? (
                      <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>{detail}</span>
                    ) : null}
                  </span>
                </label>
              )
            })}
          </div>
        ) : null}
        <div style={{ display: 'grid', gap: 4, fontSize: 13 }}>
          <span style={{ color: 'var(--muted)' }}>Fetch history</span>
          <Select
            value={String(days)}
            onChange={v => setDays(Number(v))}
            options={HISTORY_DEPTH_OPTIONS}
            title={HISTORY_DEPTH_TITLE}
          />
        </div>
        {error ? <div style={{ fontSize: 13, color: '#dc2626' }}>{error}</div> : null}
      </div>
    </AppDialog>
  )
}


// One line naming who is waiting to be let into the vault, for the strip that cannot offer an approve
// control. It sits on the **locked** strip, where the button beside it — Unlock — is exactly the next
// step: approving shares the key, so the key has to be in hand first. Named rather than counted, for the
// reason the recovery dialog names members: "somebody is waiting" is not actionable, "Robin is" is.
export function WaitingForAccess({ waiting }) {
  if (!waiting.length) return null
  // A missing name becomes a placeholder rather than being filtered out: dropping the entry would make
  // one waiter read as none, and the verb below is agreed against the number of *people* waiting, not
  // the number that happened to come back named. (The server falls back to the username, so this is a
  // guard rather than an expected state.)
  const names = waiting.map(r => r.display_name || 'Somebody')
  const who = names.length === 1 ? names[0]
    : names.length === 2 ? `${names[0]} and ${names[1]}`
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return (
    <span style={{ flexBasis: '100%', color: 'var(--accent2)' }}>
      {who} {waiting.length === 1 ? 'is' : 'are'} waiting for vault access. Unlock to approve.
    </span>
  )
}

function VaultStrip({ vault, waiting = [], onSet, onRequest, onUnlock, onUnlockPasskey,
  passkeyBusy = false, passkeyLabel = VAULT_PASSKEY_LABEL, onLock, onSettings, onRecover, onCheck }) {
  const box = (bg, border) => ({
    display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    background: bg, border: `1px solid ${border}`, borderRadius: 8, padding: '10px 14px', marginBottom: 12,
    fontSize: 13,
  })
  // On every state of the strip, since the first of them is what a new user meets before any vault exists.
  const help = <FeatureExplainer topic="credential-vault" placement="bottom-left" />
  if (!vault.configured) {
    return (
      <div style={box('var(--surface2)', 'var(--border)')}>
        {help}
        <span style={{ color: 'var(--muted)' }}>Data provider credentials are kept in an encrypted vault. Set a passphrase to begin.</span>
        <Button onClick={onSet} style={{ marginLeft: 'auto' }}>Set vault passphrase</Button>
      </div>
    )
  }
  // Waiting on someone else, and the only state on this strip with no action on it — which is why it
  // says who has to act rather than offering a button that would do nothing.
  if (vault.accessPending) {
    return (
      <div style={box('var(--surface2)', 'var(--border)')}>
        {help}
        <span style={{ color: 'var(--muted)' }}>
          Vault access requested. Someone who can already open the vault needs to approve it before you
          can connect or sync data providers.
        </span>
      </div>
    )
  }
  if (!vault.hasPassphrase) {
    return (
      <div style={box('var(--surface2)', 'var(--border)')}>
        {help}
        <span style={{ color: 'var(--muted)' }}>
          This workspace already has a credential vault. Set your own passphrase to ask for access to it.
        </span>
        <Button onClick={onRequest} style={{ marginLeft: 'auto' }}>Request vault access</Button>
      </div>
    )
  }
  if (!vault.unlocked) {
    return (
      <div style={box('rgba(234, 179, 8, 0.12)', 'rgba(234, 179, 8, 0.4)')}>
        {help}
        <span>The vault is locked. Unlock it to connect or sync.</span>
        {/* Offered first where it exists, because it is the day-to-day unlock the passkey slot was added
            for: a touch or a glance against retyping a 20-character passphrase. */}
        {/* Disabled for the duration of the ceremony, and saying so. A WebAuthn prompt is a separate
            window the browser owns, so the strip underneath still looks idle and pressable — which is
            how a second press happened, and the browser answers that with an error dialog stacked on
            top of the prompt. Busy state and wording both come from `useVaultPasskeyUnlock`, shared
            with the passphrase dialog's identical button rather than kept in step by hand. */}
        {vault.hasPasskey ? (
          <Button onClick={onUnlockPasskey} disabled={passkeyBusy} style={{ marginLeft: 'auto' }}>
            {passkeyLabel}
          </Button>
        ) : null}
        {/* Also disabled: the passphrase dialog opens *over* the passkey prompt, and dismissing one of
            two stacked asks for the same thing is the confusion this whole change is about. */}
        <Button variant={vault.hasPasskey ? 'secondary' : 'primary'} onClick={onUnlock}
          disabled={passkeyBusy}
          style={vault.hasPasskey ? undefined : { marginLeft: 'auto' }}>
          Unlock with a passphrase
        </Button>
        {/* Offered on the *locked* strip and nowhere else, because this is exactly where someone stands
            when they cannot get in. Not on the unlocked strip: a user who can open the vault is looking
            for Change passphrase, which already lives in Vault settings. Deliberately quiet — most of
            what it opens is free, but the bottom of it is irreversible, and a prominent button beside
            Unlock would be pressed by people who simply mistyped. */}
        <Button variant="secondary" onClick={onRecover} disabled={passkeyBusy}>
          Can’t open it?
        </Button>
        {/* Only a typed passphrase can be checked against a strength rule that changed since it was last
            typed, and the passkey button above is the one a passkey user reaches for — so this says
            which to use, here where the choice is made. */}
        {vault.passphraseNeedsCheck ? (
          <div style={{ flexBasis: '100%', fontSize: 12 }}>
            The vault needs to be unlocked with your passphrase, not a passkey, so it can be validated
            against the current strength rule.
          </div>
        ) : null}
        {/* Below the buttons on its own row, not competing with them: the request is somebody else's
            business to raise and this user's to get to, where the unlock above is what they came for. */}
        <WaitingForAccess waiting={waiting} />
      </div>
    )
  }
  // Still unlocked, because a passphrase that fails a tightened rule keeps opening the vault — but it
  // blocks connecting a data source and taking a backup that carries the credentials, and only its owner
  // can change it.
  // Said here because this is where both of those are attempted; Change passphrase is in Vault settings.
  if (vault.passphraseNeedsChange) {
    return (
      <div style={box('rgba(234, 179, 8, 0.12)', 'rgba(234, 179, 8, 0.4)')}>
        {help}
        <span>
          Your vault passphrase is considered too easy to guess. Change it to connect data providers or
          include the credentials in a backup.
        </span>
        <Button onClick={onSettings} style={{ marginLeft: 'auto' }}>
          {waiting.length ? `Vault settings (${waiting.length} waiting)` : 'Vault settings'}
        </Button>
        <Button variant="secondary" onClick={onLock}>Lock</Button>
      </div>
    )
  }
  return (
    <div style={box('var(--surface2)', 'var(--border)')}>
      {help}
      <span style={{ color: 'var(--muted)' }}>Vault unlocked for this session.</span>
      {/* Opened with a passkey while the passphrase is still unjudged, which is the one way to reach this
          state: the check is a typed unlock, and without this the only route to it was locking first. */}
      {vault.passphraseNeedsCheck ? (
        <Button onClick={onCheck} style={{ marginLeft: 'auto' }}>Validate passphrase</Button>
      ) : null}
      {/* Reachable only while unlocked, and that is the gate rather than the styling: approving someone
          and replacing the key both need the key in hand. The waiting count rides the button because
          this strip is the only place on the page a pending request would otherwise be visible. */}
      <Button variant="secondary" onClick={onSettings}
        style={vault.passphraseNeedsCheck ? undefined : { marginLeft: 'auto' }}>
        {waiting.length ? `Vault settings (${waiting.length} waiting)` : 'Vault settings'}
      </Button>
      <Button variant="secondary" onClick={onLock}>Lock</Button>
      {vault.passphraseNeedsCheck ? (
        <div style={{ flexBasis: '100%', fontSize: 12 }}>
          Your passphrase needs to be validated against the current strength rule. Until then backups will
          not contain the data provider credentials.
        </div>
      ) : null}
    </div>
  )
}

// Load Plaid Link on demand (so normal visits don't pull the third-party script) exactly once. A cached
// promise means repeated "Connect account" attempts reuse the same <script> and global instead of appending a
// fresh tag each time — which previously stacked multiple Link handlers, each firing its own onSuccess.
let plaidScriptPromise = null
function loadPlaidScript() {
  if (window.Plaid) return Promise.resolve()
  if (plaidScriptPromise) return plaidScriptPromise
  plaidScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js'
    script.onload = () => resolve()
    script.onerror = () => { plaidScriptPromise = null; reject(new Error('Could not load Plaid Link.')) }
    document.head.appendChild(script)
  })
  return plaidScriptPromise
}

// `onShowHistory({ connectionIds })` opens the Data Import tab's history on those connections' cards, which
// are what a sync writes to.
export default function ConnectionsTab({ onShowHistory }) {
  const { currentUser, authEnabled } = useAppSession()
  const [accounts, setAccounts] = useState([])
  // For the import-card ledger a connection card opens in place: its rows are categorizable, which is
  // the whole reason to open it here rather than send the user to find the card.
  const [categories, setCategories] = useState([])
  const onAddCategory = useCallback(category => setCategories(prev => (
    prev.some(existing => existing.id === category.id) ? prev : [...prev, category]
  )), [])
  // Merged children included, deliberately. A connection maps onto whatever account the user pointed it
  // at, and merging that account into a group does not move the mapping — so a root-only list drops
  // exactly the accounts whose mappings are still in force, leaving the card claiming nothing was
  // imported and the mapping dialog rendering a live decision as an empty select. Same reasoning as the
  // CSV mapping grid's own include_children fetch.
  const onAccountsChanged = useCallback(async () => {
    const rows = await api.getAccounts({ include_children: true }).catch(() => null)
    if (rows) setAccounts(rows.filter(account => !account.trashed_at))
  }, [])
  useEffect(() => {
    onAccountsChanged()
    api.getCategories().then(setCategories).catch(() => { })
  }, [onAccountsChanged])
  // The same panel the Accounts page opens: a connection's account list is a place a user wants to
  // look at the account from, not a dead end that sends them to another page.
  const { openAccountDetail, panelsNode: accountDetailPanelsNode } = useAccountDetailPanels({ accounts, categories })
  const [providers, setProviders] = useState(null)
  const [transport, setTransport] = useState(null)
  const [loading, setLoading] = useState(true)
  // Lifted to `SyncStatusContext`: a sync outlives this tab. While the driver lived here, navigating
  // away mid-backfill left its poll loop running in a detached closure writing to an unmounted component —
  // the work carried on invisibly and its results landed nowhere. The cards below still read the same
  // shape, they just no longer own it.
  const { syncState, runsFinished, runProviders, runConnections, watching } = useSyncStatus()
  const [configTarget, setConfigTarget] = useState(null)
  const [connectTarget, setConnectTarget] = useState(null)  // provider whose token-connect dialog is open
  // Every action needing an open vault goes through this gate: it prompts and the action then continues
  // itself (see lib/useVaultGate.js). The gate, its flags and its dialog live at App level now
  // (`contexts/VaultGateContext.jsx`), because the navigation pane can start a sync too and a prompt
  // mounted under this route could not suspend an action taken anywhere else. This page keeps only the
  // *strip* — a configuration surface — and reads the same flags the gate does.
  const {
    vault, ensureVault, openVault, adoptPasskeyUnlock, adoptVaultState, lockVault, changePassphrase,
  } = useVaultGateContext()
  const [vaultSettingsOpen, setVaultSettingsOpen] = useState(false)
  const [vaultRecoveryOpen, setVaultRecoveryOpen] = useState(false)
  // Who is waiting, not just how many: the locked strip names them, because "somebody is waiting" is not
  // something anyone can act on and "Robin is waiting" is. The queue itself still lives in the settings
  // dialog. Held here because the strip renders whether or not that dialog has ever been opened.
  const [waitingRequests, setWaitingRequests] = useState([])
  const [notice, setNotice] = useState(null)
  const [disconnectTarget, setDisconnectTarget] = useState(null) // { provider, external_id, institution }
  // Set when the provider refused to revoke: `{ target, message }`, offering removal without revoking.
  const [revokeRefused, setRevokeRefused] = useState(null)
  const [disconnecting, setDisconnecting] = useState(false)
  // The open connection card's "⋯" menu. One at a time, so it lives on the tab rather than per card.
  const [cardMenu, setCardMenu] = useState(null) // { connectionId, provider, connection, anchorElement }
  // Which connections have their account list open. Collapsed by default: the list is the card's bulk —
  // a seven-account connection ran to fifteen rows — and it is reference rather than something asking to
  // be acted on. What *is* asking (an account with no destination) is counted in the collapsed summary,
  // per the rule in `docs/ui-patterns.md` that a nudge must survive collapsing.
  const [openAccountLists, setOpenAccountLists] = useState({})
  // Which connections have their last sync's per-account chips open.
  const [openSyncDetails, setOpenSyncDetails] = useState({})
  // What the open sync log starts filtered to — `{ subjects }` (connection ids) or `{ providers }` — and null
  // while it is closed; empty subjects is the whole log. It opens as a report rather than standing on
  // the tab: it is read on the specific occasion that a sync brought in less than expected.
  const [syncLogScope, setSyncLogScope] = useState(null)
  // Per-connection sync-record summary (connection_id -> { suspects, cards }), the Connections-tab home for
  // a sync's duplicate review: a synced row lands on a per-(connection, month) import card, and unresolved
  // cross-source duplicates surface here as a badge that jumps to the Data Import tab's history to resolve them.
  const [syncSummaryByConnection, setSyncSummaryByConnection] = useState({})
  // Every non-configuration action a connection has — sync, deepen history, rebuild accounts, remove
  // synced rows — with its own dialogs, from `lib/useConnectionOperations.js`.
  const {
    sync, syncAll, pullConnectionHistory, retriedAfterUnlock,
    fetchMoreHistory, refreshConnectionAccounts, openRemoveSynced,
    busy: { refreshingConnId, fetchingHistoryConnId, removingSync },
    dialogsNode: connectionDialogsNode,
  } = useConnectionOperations({ onChanged: async () => { await onAccountsChanged?.(); await refresh() } })

  // The same floating import-card ledger the Data Import tab's history opens, hosted here so a connection's
  // last sync can be reviewed without leaving the tab. Reused rather than rebuilt: that panel is already
  // read-write for categories and already knows how to page, sort, search and bulk-edit a card's rows.
  const { openBatchDetail, panelsNode } = useBatchDetailPanels({ categories, onAddCategory })

  // Open the ledger on whatever the connection's last sync wrote to — see `lastSyncReportCards` for
  // why that can be more than one card and what scopes it.
  const openLastSyncReport = useCallback(
    connection => lastSyncReportCards(connection).forEach(openBatchDetail),
    [openBatchDetail],
  )
  // How far back a new connection's initial pull fetches (`days_requested`; 0 = all available ~24 months).
  // Persisted as the user's default for future connections. Routine syncs pull cursor deltas regardless.
  const [historyDays, setHistoryDays] = useUserPreference('connection.historyDays', 90)
  // Which provider cards are expanded, keyed by provider and remembered across visits — the tab is a
  // place people return to, and re-collapsing the same cards every visit is the kind of small tax that
  // makes a feature not worth using. Absent = the per-card default (see the render).
  const [expandedProviders, setExpandedProviders] = useUserPreference('connection.expandedProviders', {})
  // The account-mapping step. `pendingBackfill` marks the post-Link case, where mapping is required and
  // the historical pull runs only once it is resolved — an unmapped provider account has nowhere to sync
  // into, and the mapping is what gives dedupe its cross-account alias. Reopened from a connection card
  // (without `pendingBackfill`) it is a plain edit.
  const [mapTarget, setMapTarget] = useState(null)   // { connection, accounts, pendingBackfill, days }
  const [mapLoading, setMapLoading] = useState(false)
  const [mapSaving, setMapSaving] = useState(false)
  const [mapError, setMapError] = useState(null)
  const [unmappedByConnection, setUnmappedByConnection] = useState({})
  // {connectionId: [{external_account_id, label, mapped, mapping_mode}]} — names the last sync's
  // per-account counts, including accounts that received nothing.
  const [providerAccountsByConnection, setProviderAccountsByConnection] = useState({})
  // local account id -> the institution the provider says it is at, for a connection spanning several banks
  const [institutionByAccountId, setInstitutionByAccountId] = useState({})
  // While a Plaid Link (+ bank OAuth) session is open, the whole app is blocked behind a modal scrim: the
  // Link handler and its onSuccess closure live in THIS component, so navigating away mid-connect unmounts
  // it and silently loses the in-flight connection. linkInProgress drives the scrim; plaidHandlerRef lets
  // the scrim's Cancel exit Link cleanly. Cleared when Link resolves (onSuccess/onExit) or is canceled.
  const [linkInProgress, setLinkInProgress] = useState(false)
  const plaidHandlerRef = useRef(null)
  const exchangingRef = useRef(false)  // guards against a double Plaid onSuccess exchanging the same token twice

  // Browser-level leave guard (refresh / close tab / external nav) while a Link session is open. In-app
  // (SPA) navigation is already blocked by the scrim capturing every click; this catches the leaves a
  // click-scrim can't. A true React Router `useBlocker` would additionally guard programmatic route
  // changes, but that hook only works under a data router — this app mounts `BrowserRouter` — so the scrim
  // (click capture) + this beforeunload are the equivalent without an app-wide router migration.
  useEffect(() => {
    if (!linkInProgress) return
    const warn = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [linkInProgress])

  const isAdmin = !authEnabled || currentUser?.role === 'admin'
  // From another device the app secret and bank tokens cross the network, so connecting needs HTTPS.
  const httpsBlocked = !!(transport && !transport.is_loopback && !transport.is_https)

  const refresh = useCallback(async () => {
    const [status, provResp, batches] = await Promise.all([
      api.getAuthStatus().catch(() => ({})),
      api.getProviders().catch(() => ({ providers: [] })),
      api.listBatches().catch(() => []),
    ])
    setTransport(status.transport || null)
    const u = status.user || currentUser || {}
    // This refresh already holds the server's current answer, so the strip below self-corrects against a
    // vault the server has since dropped on its idle timeout. Adopted only when the vault state actually
    // differs — see `adoptVaultState`, which this refresh would otherwise re-trigger endlessly.
    adoptVaultState(status.user)
    // Asked of anyone who *could* approve — a member holding an unlock method — rather than only someone
    // whose vault is open right now. Gating this on `vault_unlocked` hid the queue from the one person
    // who needed telling: somebody who does not routinely unlock never learns there is anything to
    // unlock *for*, so the requester waits on a signal nobody sends. A non-member still sees nothing,
    // since there is no moment at which they could act on it.
    if (u.vault_has_passphrase) {
      const pending = await api.vaultAccessRequests().catch(() => ({ requests: [] }))
      setWaitingRequests((pending.requests || []).filter(r => r.user_id !== u.id))
    } else {
      setWaitingRequests([])
    }
    setProviders(provResp.providers || [])
    // Roll each connection's sync period cards up to a suspect/card count for the review badge below.
    const summary = {}
    for (const b of (batches || [])) {
      if (b.source_kind !== 'connection_sync' || !b.connection_id) continue
      const entry = summary[b.connection_id] || (summary[b.connection_id] = { suspects: 0, cards: 0 })
      entry.suspects += Math.max(0, Number(b.suspect_duplicate_count || 0))
      entry.cards += 1
    }
    setSyncSummaryByConnection(summary)
    // How many of each connection's provider accounts still have no destination. Drives the "N to map"
    // nudge on the card: an unmapped account is silently skipped by every sync until it is resolved, so
    // the state has to be visible rather than inferred from missing transactions.
    const unmapped = {}
    const providerAccounts = {}
    // The institution each mapped account actually sits at, which the connection heading cannot say when
    // one credential spans several banks (a SimpleFIN access URL does). It rides the same fetch as the
    // mapping counts because `connection_account` is where the provider's own naming is kept — a local
    // account carries the name the user gave it, not the bank's.
    const institutions = {}
    await Promise.all(
      (provResp.providers || []).flatMap(p => (p.connections || []).map(async c => {
        try {
          const res = await api.getConnectionAccounts(c.id)
          unmapped[c.id] = res.unmapped || 0
          // Kept for the last-sync breakdown: it is keyed by the *provider's* account id, and only this
          // list can name one that has no local account — which is exactly the row worth showing, since an
          // account receiving nothing cannot appear in any tally built from what landed.
          providerAccounts[c.id] = (res.accounts || []).map(pa => ({
            external_account_id: pa.external_account_id,
            label: pa.source_label || pa.provider_name || pa.external_account_id,
            mapped: !!pa.mapped,
            mapping_mode: pa.mapping_mode,
          }))
          for (const pa of res.accounts || []) {
            if (pa.account_id && pa.provider_official_name) {
              institutions[pa.account_id] = pa.provider_official_name
            }
          }
        } catch { /* a connection whose accounts can't be read just shows no badge */ }
      })),
    )
    setUnmappedByConnection(unmapped)
    setProviderAccountsByConnection(providerAccounts)
    setInstitutionByAccountId(institutions)
    setLoading(false)
  }, [adoptVaultState, currentUser])

  useEffect(() => { refresh() }, [refresh])

  // Reload when a sync run ends, wherever it was started — this card's own ↻ Sync, the navigation pane,
  // another tab. The duplicate badge and last-sync breakdown are this tab's copy of what the run wrote, and
  // a run started elsewhere used to leave them stale until the page reloaded. The one reload per run: the
  // shared operations no longer settle after a run as well. Keyed to the count seen at mount, so arriving
  // on the page after earlier runs does not repeat the load the mount just did.
  const handledRunsRef = useRef(runsFinished)
  useEffect(() => {
    if (runsFinished === handledRunsRef.current) return
    handledRunsRef.current = runsFinished
    ;(async () => {
      await onAccountsChanged?.()
      await refresh()
    })()
  }, [runsFinished, onAccountsChanged, refresh])

  // Accounts link a connection by account.connection_id == connection.id (6b-3). CSV/manual accounts and
  // disconnected ones have a NULL connection_id, so they naturally fall out of every connection group. The
  // authoritative connection list comes from the backend (p.connections).
  // Provider accounts this connection offers that feed no local account — unmapped, or deliberately
  // skipped. They are the half of "what is this connection pulling?" the local-account list cannot show,
  // and the half a user cannot otherwise see without opening the mapping dialog: a skipped account is
  // invisible everywhere else, so its absence reads as the bank not sharing it.
  const unfedProviderAccounts = useCallback((connection) => (
    (providerAccountsByConnection[connection.id] || []).filter(pa => !pa.mapped)
  ), [providerAccountsByConnection])

  const accountsForConnectionId = useCallback((connectionId) => {
    return (accounts || []).filter(a => a.connection_id === connectionId)
  }, [accounts])

  // Resolves a merged child's group name for the card's account rows.
  const accountLabelById = useMemo(
    () => new Map((accounts || []).map(a => [a.id, a.display_name || a.name])),
    [accounts],
  )

  // Every save needs the vault, and the three values only work as a set, so the dialog opens behind the
  // gate rather than prompting part-way through an edit.
  async function openConfig(p) {
    if (!(await ensureVault())) return
    setConfigTarget(p)
  }

  async function saveConfig(provider, payload) {
    await api.saveProviderConfig(provider, payload)
    await refresh()
    setConfigTarget(null)
  }

  // The strip's button, on the same hook the unlock dialog uses. A refused or dismissed ceremony leaves
  // the strip as it was rather than opening anything, because the passphrase is still one click away on
  // the button beside it — so a refusal here is a notice, where in the dialog it is an inline error.
  const { busy: passkeyBusy, unlock: unlockWithPasskey, label: passkeyLabel } = useVaultPasskeyUnlock({
    onUnlocked: adoptPasskeyUnlock,
    onRefused: message => setNotice({ title: 'Could not use a passkey', description: message }),
  })


  // The connect affordance comes from the provider's own `connect_spec`, not from its name: a Link-style
  // provider opens its widget, a token-style one collects a pasted value. The vault and HTTPS gates are
  // shared, since they are about the credential this produces rather than how it was obtained. HTTPS is
  // the one gate that stays a refusal: no dialog can resolve it from here.
  async function connect(p) {
    if (!(await ensureVault())) return
    if (httpsBlocked) {
      setNotice(UNPROTECTED_LINK_NOTICE)
      return
    }
    if (p.connect_spec?.style === 'token') { setConnectTarget(p); return }
    startPlaidLink()
  }

  // Re-authorize a connection in place. Same gates as `connect` — this stores a refreshed credential just
  // as a first connect does — but it opens Link in update mode against the Item this connection already
  // holds, so nothing about the connection is replaced.
  async function reconnect(connection) {
    if (!(await ensureVault())) return
    if (httpsBlocked) {
      setNotice(UNPROTECTED_LINK_NOTICE)
      return
    }
    startPlaidLink(connection)
  }

  // Finish a token-style connect: the same tail Link takes after its callback — refresh, then either the
  // mapping step (which owns the backfill from there) or a straight historical pull.
  async function connectWithToken(provider, token, days, adoptConnectionId = null) {
    let result
    try {
      result = await api.connectProvider(provider, { setup_token: token }, adoptConnectionId)
    } catch (e) {
      // The vault can be dropped between opening this dialog and submitting it, so prompt and send the
      // same token again — a 423 never reached the provider, so a single-use setup token is still good.
      // Anything else (including a declined prompt) goes back to the dialog, which keeps the token on
      // screen and reports the reason.
      if (e.status !== 423 || !(await ensureVault({ force: true }))) throw e
      result = await api.connectProvider(provider, { setup_token: token }, adoptConnectionId)
    }
    // A replacement the server could not honour still connected — the authorization is spent either way —
    // but it landed as a *second* connection rather than re-pointing the first, which is a different thing
    // to be looking at. Said plainly rather than left to be discovered as an unexpected extra card.
    if (adoptConnectionId && result && !result.adopted) {
      setNotice({
        title: 'Added as a new connection',
        description: 'The connection this was meant to replace could not be matched, so it was added alongside it. The original can be disconnected from its card once its accounts have been checked.',
      })
    }
    // Remember the depth chosen in the dialog as the default for next time, but go on using the value that
    // was actually on screen — the persisted copy is a convenience, not the source of truth for this pull.
    if (days !== historyDays) setHistoryDays(days)
    setConnectTarget(null)
    await refresh()
    if (result?.connection_id) {
      if (result.unmapped) {
        await openAccountMap(
          { id: result.connection_id, provider, institution: result.institution },
          { pendingBackfill: true, days },
        )
        return
      }
      await pullConnectionHistory(provider, {
        connectionId: result.connection_id, days,
        failureTitle: 'Connected, but could not pull history',
      })
    }
    await onAccountsChanged?.()
    await refresh()
  }

  // The historical pull that follows a connect or a mapping decision — the same three moves each time:
  // mark the provider syncing, poll to completion, and report a failure without implying the step it
  // followed (the connect, the mapping save) failed with it. A locked vault is handled rather than
  // reported, since the credential is needed by this pull alone and the operation before it is done.

  // `repairConnection` switches Link into **update mode**: it re-authorizes the Item that connection
  // already holds rather than creating a new one. That is the difference between repairing a connection
  // and replacing it — a plain session mints a new item_id and new per-account ids, so the credential
  // lands on a second row and the original keeps a "reconnect needed" badge nothing can ever clear.
  //
  // The callback differs to match: update mode issues no new credential, and Plaid's guidance is not to
  // exchange the public token it hands back, so the tail is a repair (prove the Item answers, refresh the
  // shared-account list) rather than a connect.
  async function startPlaidLink(repairConnection = null) {
    try {
      const { link_token } = await api.getLinkToken(repairConnection?.id || null)
      await loadPlaidScript()  // loaded once and reused — not re-appended per attempt (would stack handlers)
      const handler = window.Plaid.create({
        token: link_token,
        onSuccess: async (public_token, metadata) => {
          // Plaid's onSuccess can fire more than once; exchange is single-use per token, so guard against a
          // second concurrent call racing into /exchange (the backend is idempotent too, belt-and-braces).
          if (exchangingRef.current) return
          exchangingRef.current = true
          try {
            if (repairConnection) {
              const repaired = await api.repairPlaidConnection(repairConnection.id)
              setLinkInProgress(false)
              plaidHandlerRef.current = null
              await refresh()
              // A repair can change *which* accounts the bank shares, so a newly-offered one arrives
              // unmapped and needs the same step a fresh connect would send it to.
              if (repaired.unmapped) await openAccountMap(repairConnection)
              await onAccountsChanged?.()
              await refresh()
              return
            }
            const result = await api.exchangeToken(public_token, metadata.institution?.name)
            // Link + OAuth are done and the token is now a durable connection — lift the modal block here,
            // BEFORE the (possibly minutes-long) historical backfill, so the app isn't frozen while history
            // streams in. The sync has its own progress UI and resumes from the cursor if interrupted.
            setLinkInProgress(false)
            plaidHandlerRef.current = null
            if (result?.connection_id) {
              await refresh()
              if (result.unmapped) {
                // Accounts still need a destination. The mapping step owns the backfill from here: it
                // runs once every account is resolved, so the first rows pulled are deduped against the
                // accounts they were mapped onto rather than landing unattached.
                await openAccountMap(
                  { id: result.connection_id, provider: result.provider || 'plaid', institution: metadata.institution?.name },
                  { pendingBackfill: true, days: historyDays },
                )
                return
              }
              // Everything was already mapped (a re-link of a bank Luma still knows), so pull straight
              // away — polling until the provider signals the historical backfill is complete.
              await pullConnectionHistory('plaid', {
                connectionId: result.connection_id, days: historyDays,
                failureTitle: 'Connected, but could not pull history',
              })
            }
            await onAccountsChanged?.()
            await refresh()
          } catch (e) {
            setNotice({ title: 'Could not finish connecting', description: e.message })
          } finally {
            exchangingRef.current = false
            setLinkInProgress(false)  // idempotent: also covers an exchange that threw before the release above
          }
        },
        onExit: (err, metadata) => {
          // The user closed Link, or it errored out — lift the block either way.
          setLinkInProgress(false)
          plaidHandlerRef.current = null
          // An error inside Link happens entirely in the browser, so the connection log hears of it only
          // from here. Best effort: the log is a diagnostic, and failing to write it is not the user's
          // problem on top of the connect that already failed.
          if (err) {
            api.reportPlaidLinkError({
              connectionId: repairConnection?.id || null,
              institutionName: metadata?.institution?.name || null,
              requestId: metadata?.request_id || null,
              error: err,
            }).catch(() => {})
          }
        },
      })
      // Arm the block right before opening Link, and keep the handle so the scrim's Cancel can exit cleanly.
      plaidHandlerRef.current = handler
      setLinkInProgress(true)
      handler.open()
    } catch (e) {
      setLinkInProgress(false)
      plaidHandlerRef.current = null
      if (await retriedAfterUnlock(e, startPlaidLink)) return
      setNotice({ title: 'Could not start the connection', description: e.message })
    }
  }

  // Escape hatch for the connect scrim: never let a stalled Link session trap the app. Exits/destroys Link
  // (which also fires onExit) and lifts the block directly, so the user is freed even if onExit never comes.
  function cancelPlaidLink() {
    try {
      plaidHandlerRef.current?.exit?.({ force: true })
      plaidHandlerRef.current?.destroy?.()
    } catch (e) {
      console.error('Plaid Link cancel failed', e)
    }
    plaidHandlerRef.current = null
    exchangingRef.current = false
    setLinkInProgress(false)
  }


  // Open the account-mapping step for a connection. `pendingBackfill` (post-Link) makes every account
  // require a decision and defers the historical pull until they have one; without it this is a plain
  // edit of an existing mapping.
  async function openAccountMap(connection, { pendingBackfill = false, days = null } = {}) {
    setMapError(null)
    setMapLoading(true)
    setMapTarget({ connection, accounts: [], captureFields: [], pendingBackfill, days })
    try {
      const res = await api.getConnectionAccounts(connection.id)
      setMapTarget({
        connection: res.connection || connection,
        accounts: res.accounts || [],
        captureFields: res.capture_fields || [],
        pendingBackfill, days,
      })
      setUnmappedByConnection(prev => ({ ...prev, [connection.id]: res.unmapped || 0 }))
    } catch (e) {
      setMapError(e.message)
    } finally {
      setMapLoading(false)
    }
  }

  // Optional capture fields are saved as they are toggled rather than with the mapping: they are a
  // per-connection setting, not part of the mapping decision, and persisting immediately means a user
  // who closes the dialog without saving a mapping change still keeps the capture choice.
  async function toggleCaptureField(key, enabled) {
    const target = mapTarget
    if (!target) return
    const next = (target.captureFields || []).map(f => (f.key === key ? { ...f, enabled } : f))
    setMapTarget(prev => (prev ? { ...prev, captureFields: next } : prev))
    try {
      const res = await api.setConnectionCapturedFields(
        target.connection.id,
        next.filter(f => !f.locked && f.enabled).map(f => f.key),
      )
      setMapTarget(prev => (prev ? { ...prev, captureFields: res.capture_fields || next } : prev))
    } catch (e) {
      setMapError(e.message)
    }
  }

  async function saveAccountMap(mappings) {
    const target = mapTarget
    if (!target) return
    setMapSaving(true)
    setMapError(null)
    try {
      const res = await api.setConnectionAccountMap(target.connection.id, mappings)
      setUnmappedByConnection(prev => ({ ...prev, [target.connection.id]: res.unmapped || 0 }))
      setMapTarget(null)
      await onAccountsChanged?.()
      // Post-Link: the accounts now exist, so the deferred historical pull can run. It is deliberately
      // after the mapping rather than before, so the very first batch of rows is deduped against
      // whatever the mapped accounts already hold instead of arriving unattached.
      // Two occasions need a pull right after mapping, and they are the same pull: the post-connect
      // backfill, and an account that joined an existing connection later (discovered by sync) and so has
      // no history yet. Without running it here, a just-mapped account sits visibly empty until some later
      // sync happens to collect it.
      if (target.pendingBackfill || res.awaiting_history?.length) {
        await pullConnectionHistory(target.connection.provider || 'plaid', {
          connectionId: target.connection.id,
          days: target.days ?? historyDays,
          failureTitle: 'Mapped, but could not pull history',
        })
        await onAccountsChanged?.()
      }
      // A mapping change re-checks whatever this connection had already synced, since the decision
      // just made is what those rows were missing. Silent when it finds nothing; reported when it
      // acts, because it removed transactions the user could otherwise see vanish unexplained.
      const removed = (res.rescan?.hard_rejected || 0) + (res.rescan?.promoted || 0)
      const flagged = (res.rescan?.soft_flagged || 0) + (res.rescan?.swept || 0)
      if (removed || flagged) {
        const parts = []
        if (removed) parts.push(`${removed} removed as ${removed === 1 ? 'a duplicate' : 'duplicates'}`)
        if (flagged) parts.push(`${flagged} flagged for review`)
        setNotice({
          title: 'Mapping applied — already-synced transactions re-checked',
          description: `${parts.join(', ')}. Removed transactions keep their category and can be restored `
            + 'from this connection’s cards in Import history.',
        })
      }
      await refresh()
    } catch (e) {
      setMapError(e.message)
    } finally {
      setMapSaving(false)
    }
  }

  // Rebuild a connection's account rows from its still-valid credential (no re-link), then poll-sync its
  // history. The one-click recovery after a restore rolled back the accounts but kept the connection.

  // Deepen one connection's history: request all available history and poll to completion. `fullHistory`
  // is what separates this from a routine top-up, which sends the same `days` — for Plaid it raises
  // days_requested and the provider backfills older transactions through the same cursor, while a provider
  // with no cursor reads it as "walk further back" rather than "fetch the recent window again". It is also
  // the only kind of pull permitted to widen the connection's coverage claim backward. A bank/plan may cap
  // how far back it goes.

  // Remove everything a connection has synced. The cursor reset that comes with it is why this is a
  // connection-level action rather than a per-card Undo: a routine sync only pulls changes since the
  // cursor, so rows deleted without it would be beyond the reach of any later sync. The dialog opens on
  // the preflight rather than on cached card counts, since the numbers it states are what gets deleted.


  // Disconnecting revokes the credential where the provider allows it, so it needs the vault open. The
  // prompt deliberately comes *after* the confirmation rather than gating the menu item: a passphrase is
  // only worth asking for once the user has committed to disconnecting. The confirm dialog stays open
  // underneath, so backing out of the prompt returns to the decision instead of discarding it.
  async function confirmDisconnect() {
    if (!disconnectTarget) return
    if (!(await ensureVault())) return
    setDisconnecting(true)
    try {
      await api.disconnectProvider(disconnectTarget.provider, disconnectTarget.external_id)
      setDisconnectTarget(null)
      await onAccountsChanged?.()
      await refresh()
    } catch (e) {
      if (await retriedAfterUnlock(e, confirmDisconnect)) return
      const target = disconnectTarget
      setDisconnectTarget(null)
      // A refusal can be one that never clears (app credentials moved to another environment, a provider
      // account that ended), so the connection can be removed anyway, said plainly to leave access live.
      if (e.detail?.code === 'revoke_failed') setRevokeRefused({ target, message: e.message })
      else setNotice({ title: 'Could not disconnect', description: e.message })
    } finally {
      setDisconnecting(false)
    }
  }

  async function removeWithoutRevoking() {
    const { target } = revokeRefused
    setDisconnecting(true)
    try {
      await api.disconnectProvider(target.provider, target.external_id, { removeWithoutRevoking: true })
      setRevokeRefused(null)
      await onAccountsChanged?.()
      await refresh()
    } catch (e) {
      setRevokeRefused(null)
      setNotice({ title: 'Could not remove the connection', description: e.message })
    } finally {
      setDisconnecting(false)
    }
  }

  if (loading) return <Card style={{ width: IMPORT_CONFIG_MAX_WIDTH, padding: 0 }}><Spinner /></Card>

  const list = providers || []
  // The card menu and the disconnect dialog need a provider's declared capabilities, and both are rendered
  // outside the per-provider loop that has them in hand.
  const providerById = Object.fromEntries(list.map(p => [p.provider, p]))
  const configured = list.filter(p => p.configured)
  const unconfigured = list.filter(p => !p.configured)
  // What the tab's own Sync now covers and when it is busy — the same "is a sync happening?" expression
  // the sync panel and the navigation control use, so the three cannot disagree.
  const connected = list.filter(p => (p.connections || []).length)
  const connectionCount = connected.reduce((n, p) => n + p.connections.length, 0)
  const syncingAny = runProviders.some(p => syncState[p]?.syncing)
    || watching
    || connected.some(p => p.connections.some(c => c.syncing))

  // Everything the collapsed header has to be able to say, so that collapsing a card never hides
  // something that is asking to be acted on. A card is only worth collapsing if what it conceals is
  // routine detail; a failing connection or an unmapped account is neither.
  // A plain function rather than a memo: it sits after this component's early `loading` return, where a
  // hook cannot go.
  const providerSummary = p => providerConnectionStates(p, {
    unmappedByConnection,
    reviewByConnection: syncSummaryByConnection,
  })

  return (
    <>
    <div style={{ display: 'grid', gap: 12, width: IMPORT_CONFIG_MAX_WIDTH }}>
      {/* Modal block while Plaid Link is open. Plaid's own iframe sits at ~max z-index, so Link stays fully
          interactive above this scrim; the scrim (z 2000, above app chrome) covers the app so a stray click
          can't reach nav and unmount this component mid-connect. Cancel is the never-trapped escape hatch. */}
      {linkInProgress ? (
        <OverlayBackdrop zIndex={2000}>
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
            padding: '20px 22px', maxWidth: 380, textAlign: 'center', display: 'grid', gap: 10,
            pointerEvents: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.28)',
          }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Connecting your account…</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
              Finish the steps in the connection window. The rest of the app is paused so a stray click can’t interrupt it.
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 4 }}>
              <Button variant="secondary" onClick={cancelPlaidLink}>Cancel</Button>
            </div>
          </div>
        </OverlayBackdrop>
      ) : null}
      <VaultStrip
        vault={vault}
        waiting={waitingRequests}
        onSet={() => openVault('set')}
        onRequest={() => openVault('request')}
        onUnlock={() => openVault('unlock', { offerPasskey: false })}
        onUnlockPasskey={unlockWithPasskey}
        passkeyBusy={passkeyBusy}
        passkeyLabel={passkeyLabel}
        onSettings={() => setVaultSettingsOpen(true)}
        onRecover={() => setVaultRecoveryOpen(true)}
        onCheck={() => openVault('check')}
        onLock={lockVault}
      />

      {connected.length ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {/* Unfiltered, where each card's own button starts at its provider: "a sync brought in less than
              I expected" is as often a question about the whole run as about one connection. */}
          <Button variant="secondary" onClick={() => setSyncLogScope({ subjects: [] })}
            title="What every sync, connect and disconnect actually did — how much arrived, whether the full history was fetched, and anything the provider reported">
            Sync log
          </Button>
          <Tooltip describeTrigger content={syncingAny
            ? 'A sync is already running'
            : `Pull new and changed transactions for all ${connectionCount} connection${connectionCount === 1 ? '' : 's'}`}>
            <Button onClick={syncAll} disabled={syncingAny}>
              {syncingAny ? 'Syncing…' : '↻ Sync now'}
            </Button>
          </Tooltip>
        </div>
      ) : null}

      {configured.length === 0 && unconfigured.length === 0 ? (
        <Card style={{ padding: 16 }}>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>No data providers are available.</p>
        </Card>
      ) : null}

      {configured.map(p => {
        const connections = p.connections || []
        const ss = syncState[p.provider] || {}
        const syncedCardIds = rosterCardIds(runConnections.filter(e => e.provider === p.provider))
        // Any connection of this provider reporting a live sync — the server's own view, which outlives
        // the page that started it (see `sync_started_at`).
        const serverSyncing = connections.some(c => c.syncing)
        // A locked vault deliberately does NOT disable this: clicking asks for the passphrase and then
        // goes on to connect. What still disables is what no dialog here can resolve — missing HTTPS,
        // and a vault this user cannot open yet, whether because they have not asked for access or
        // because the request has not been approved. Both of those are answered on the strip above,
        // which is where the button's hover points.
        const noVaultSlot = vault.configured && !vault.hasPassphrase
        const connectDisabled = noVaultSlot || httpsBlocked
        const connectTitle = vault.accessPending ? 'Waiting for your vault access to be approved'
          : noVaultSlot ? 'Request access to this workspace’s credential vault first'
            : httpsBlocked ? 'Needs HTTPS, or a browser on the computer the server runs on'
              : ''
        const s = providerSummary(p)
        const lastSyncedLabel = formatTimestamp(s.lastSynced)
        // Same syncing expression the button below uses, deliberately: `ss.syncing` is this component's
        // memory of a pull it started and turns over immediately on click, while `serverSyncing` is the
        // connection's own marker and survives a navigation. Reading only one of them would let the button
        // and the line beside it disagree, which is the class of bug this line already had once. The
        // precedence itself lives in `providerSummaryLine`.
        const summaryLine = providerSummaryLine({
          connectionCount: connections.length,
          syncing: ss.syncing || serverSyncing,
          lastSyncedLabel,
        })
        const allowanceLines = connectionsAllowanceLines(connections)
        const expanded = expandedProviders[p.provider] !== undefined
          ? expandedProviders[p.provider]
          // Default: open while there is nothing to sync yet (the card is a setup step, and collapsing
          // it would hide the only action available), collapsed once it is connected and doing its job.
          : connections.length === 0
        return (
          <SectionCard
            key={p.provider}
            title={providerLabel(p.provider)}
            summary={(
              // A metered provider's requests left ride on the hover, so they are there while collapsed.
              <HoverLines lines={allowanceLines}>
                <span aria-label={[summaryLine, ...allowanceLines].join('. ')}>{summaryLine}</span>
              </HoverLines>
            )}
            collapsible
            expanded={expanded}
            onExpandedChange={(next) => setExpandedProviders({ ...expandedProviders, [p.provider]: next })}
            width="100%"
            headerCenter={
              // Everything here has to survive collapsing, because each item is asking for something and
              // a nudge only visible after expanding a card is a nudge that will not be seen. The env
              // badge is the exception and stays last: it is context, not a request.
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {s.reauth.length ? (
                  // First, and its own pill rather than another failure count. Every other sync failure
                  // resolves itself or does not; this one waits on the user, and a count of attempts is
                  // exactly the wrong thing to show for a connection that will never succeed again.
                  <StatusPill tone="danger"
                    title={s.reauth.map(c => `${c.institution || 'Connection'}: ${c.last_sync_error || 'the provider no longer accepts this connection'}`).join('\n')}>
                    ⚠ {s.reauth.length === 1 ? 'reconnect needed' : `${s.reauth.length} need reconnecting`}
                  </StatusPill>
                ) : null}
                {s.failing.length ? (
                  <StatusPill tone="danger"
                    title={s.failing.map(c => `${c.institution || 'Connection'}: ${c.last_sync_error || 'sync failed'} (${c.consecutive_sync_failures} in a row)`).join('\n')}>
                    ⚠ {s.failing.length === connections.length && connections.length > 1
                      ? 'all connections failing'
                      : `${s.failing.length} failing`}
                  </StatusPill>
                ) : null}
                {s.warned.length ? (
                  // Labelled as a message from the provider rather than as "partly synced": the pill
                  // cannot tell a bank that failed to deliver from a server advisory about the request
                  // itself, and asserting missing data when none is missing would send the user looking
                  // for a problem that isn't there. The text they need is the provider's own, in the
                  // tooltip — which says "authentication required" when that is what happened.
                  <StatusPill tone="warning"
                    title={s.warned.map(c => `${c.institution || 'Connection'}: ${(c.last_sync_warnings || []).join('; ')}`).join('\n')}>
                    ⚠ provider notice
                  </StatusPill>
                ) : null}
                {s.unmapped ? (
                  <StatusPill tone="accent2"
                    title={`${s.unmapped} account${s.unmapped === 1 ? '' : 's'} from this provider ${s.unmapped === 1 ? 'has' : 'have'} no destination yet — transactions for ${s.unmapped === 1 ? 'it' : 'them'} are skipped until mapped`}>
                    {s.unmapped} to map
                  </StatusPill>
                ) : null}
                {s.review ? (
                  <StatusPill tone="warning"
                    onClick={() => onShowHistory?.({
                      connectionIds: connections.filter(c => syncSummaryByConnection[c.id]?.suspects > 0).map(c => c.id),
                    })}
                    title={`${s.review} synced transaction${s.review === 1 ? '' : 's'} may duplicate an existing row — open the Import history to review`}>
                    ⚠ {s.review} to review
                  </StatusPill>
                ) : null}
                <EnvBadge env={p.env} />
              </span>
            }
            // No provider-level "Sync now": the routine pull is one control for every connection, at the
            // top of the tab and in the navigation pane. What a card has is the per-connection check
            // below, which answers a different question: "did the thing I just configured work?"
          >
            <div style={{ padding: '12px 16px 14px', display: 'grid', gap: 12 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {/* Configure only where there is something to configure — a provider with no app-level
                    credential would open a dialog with no fields in it. */}
                {isAdmin && p.requires_app_config !== false
                  ? <Button variant="secondary" onClick={() => openConfig(p)}>Configure</Button> : null}
                {/* Named for what one connect action adds, which the adapter declares (`connect_noun`)
                    because it differs in kind: Plaid's widget authorizes one institution, while a
                    SimpleFIN setup token claims a bridge that may span several banks and so has no noun
                    to name — that button stays a bare "+ Connect". The provider's own name is not it: it
                    already labels the card this button sits in. Never "account", which means a ledger
                    account everywhere else in the app. */}
                <Tooltip describeTrigger content={connectTitle}>
                  <Button onClick={() => connect(p)} disabled={connectDisabled}>
                    {p.connect_noun ? `+ Connect ${p.connect_noun}` : '+ Connect'}
                  </Button>
                </Tooltip>
                {/* Scoped to this provider, since that is what the card it sits in is about — by provider
                    rather than by its connections' ids, so the scope takes in what has no live connection
                    to name: a failed connect, and a disconnected connection's record. Offered with no
                    connections at all for the same reason: a first connect that failed is exactly when
                    the log is wanted. The log's own pills widen it to the rest. */}
                <Button variant="secondary" onClick={() => setSyncLogScope({ providers: [p.provider] })}
                  title="What each sync, connect and disconnect actually did — how much arrived, whether the full history was fetched, and anything the provider reported">
                  Sync log
                </Button>
              </div>
              {/* Only for a provider whose connect step opens straight into the provider's own widget:
                  there is no dialog of ours to ask in, so the depth has to be chosen before the button is
                  pressed. A token-style provider asks inside its connect dialog instead, at the moment it
                  applies — a second copy here would be a control for a choice already made. */}
              {p.connect_spec?.style !== 'token' ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
                  <span>New connections fetch</span>
                  <Select
                    value={String(historyDays)}
                    onChange={v => setHistoryDays(Number(v))}
                    options={HISTORY_DEPTH_OPTIONS}
                    title={HISTORY_DEPTH_TITLE}
                    style={{ fontSize: 12, padding: '4px 8px', minWidth: 0, width: 'auto' }}
                  />
                </span>
              ) : null}

              {ss.syncing ? (
                <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: 'var(--muted)' }}>
                  {ss.progress
                    ? `Importing history… ${ss.progress.added} added so far${ss.status === 'INITIAL_UPDATE_COMPLETE' ? ' (fetching older transactions…)' : ''}`
                    : 'Importing history…'}
                </div>
              ) : ss.result ? (
                <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: 'var(--muted)' }}>
                  {ss.incomplete
                    ? `Synced ${ss.result.added} so far — the bank is still sending history. Click Sync now again in a minute to pull the rest.`
                    : ss.paused?.length
                      // Named for what the user sees and what to do about it. Retrying now would not help
                      // and would push the provider toward cutting the connection off entirely.
                      ? `Synced ${ss.result.added} transactions — exhausted ${providerLabel(p.provider)} limit on requests/day. History retrieval will restart on the next sync after the limit resets.`
                      // No skipped count, for the reason given on the sync panel's finished row: it is almost
                      // all rows already held, and a bare total beside "0 added" reads as a failure.
                      : ss.result.added || ss.result.updated || ss.result.removed
                        ? `Sync complete — ${ss.result.added} added, ${ss.result.updated} updated${ss.result.removed ? `, ${ss.result.removed} removed` : ''}`
                        : 'Sync complete — nothing new'}
                  {/* The cards this run added rows to, in the history where their outcome is kept. */}
                  {syncedCardIds.length ? (
                    <LinkButton onClick={() => onShowHistory?.({ batchIds: syncedCardIds })} style={{ marginLeft: 10, fontSize: 13 }}>
                      View in import history →
                    </LinkButton>
                  ) : null}
                </div>
              ) : null}

              {connections.length ? (
                <div style={{ display: 'grid', gap: 10 }}>
                  {connections.map(c => {
                    const accts = accountsForConnectionId(c.id)
                    const syncSummary = syncSummaryByConnection[c.id]
                    return (
                      <div key={c.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', display: 'grid', gap: 6 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span style={{ fontWeight: 600, fontSize: 13 }}>{c.institution || 'Linked bank'}</span>
                          {/* The outcome line below says whether the last pull worked; this says when it
                              was. Without it "Success" cannot be told apart from a check made thirty
                              seconds ago and one from last week — which is exactly the question the Sync
                              button beside it creates. */}
                          <LastSyncedLine lastSyncedAt={c.last_synced_at} requestAllowance={c.request_allowance} />
                          {syncSummary?.suspects > 0 ? (
                            <StatusPill
                              tone="warning"
                              onClick={() => onShowHistory?.({ connectionIds: [c.id] })}
                              title={`${syncSummary.suspects} synced transaction${syncSummary.suspects === 1 ? '' : 's'} may duplicate an existing row — open the Import history to review this connection's sync cards`}
                            >
                              ⚠ {syncSummary.suspects} to review
                            </StatusPill>
                          ) : null}
                          {unmappedByConnection[c.id] > 0 ? (
                            <StatusPill
                              onClick={() => openAccountMap(c)}
                              title={`${unmappedByConnection[c.id]} account${unmappedByConnection[c.id] === 1 ? '' : 's'} from this connection ${unmappedByConnection[c.id] === 1 ? 'has' : 'have'} no destination yet — transactions for ${unmappedByConnection[c.id] === 1 ? 'it' : 'them'} are skipped until mapped`}
                            >
                              {unmappedByConnection[c.id]} to map
                            </StatusPill>
                          ) : null}
                          {/* Card maintenance lives behind one "⋯" rather than a row of buttons. These
                              actions are real but rare, and five permanent controls per card meant a
                              screenful of them at seven connections — louder than the badges above, which
                              are the part of the card that is actually asking for something. Busy state
                              shows beside the trigger, since the menu it lives in is closed while the
                              work runs. */}
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
                            {fetchingHistoryConnId === c.id || refreshingConnId === c.id ? (
                              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                                {fetchingHistoryConnId === c.id ? 'Fetching…' : 'Refreshing…'}
                              </span>
                            ) : null}
                            {/* Small and quiet on purpose, and *not* a second home for the routine pull —
                                that is Sync now at the top of the tab. This one exists because the changes made
                                on this card (a mapping, a reconnect, a fresh connection) are only really
                                confirmed by data arriving, and the effect of an action belongs where the
                                action was taken. Scoped to this connection alone, and its outcome lands
                                on the line below rather than sending the user elsewhere to look. */}
                            <Button variant="secondary"
                              onClick={() => sync(p.provider, { connectionId: c.id })}
                              disabled={ss.syncing || serverSyncing || !!refreshingConnId || !!fetchingHistoryConnId}
                              title={`Check this connection by pulling anything new from ${c.institution || 'it'} now`}>
                              {c.syncing ? 'Syncing…' : '↻ Sync'}
                            </Button>
                            <ActionMenuButton
                              open={cardMenu?.connectionId === c.id}
                              title={`Actions for ${c.institution || 'this connection'}`}
                              disabled={!!refreshingConnId || !!fetchingHistoryConnId || ss.syncing || removingSync}
                              onOpen={element => setCardMenu({ connectionId: c.id, provider: p.provider, connection: c, anchorElement: element })}
                            />
                          </div>
                        </div>
                        {/* Stated on the card as well as in the header pill. The pill has to work while
                            collapsed, so it summarizes across connections; this is where the user is when
                            they act, and with several connections under one provider it is the only place
                            that says which one. */}
                        {c.reauth_required ? (
                          <div style={{
                            fontSize: 12, lineHeight: 1.5, borderRadius: 6, padding: '6px 9px',
                            background: 'color-mix(in srgb, var(--danger) 10%, var(--surface2))',
                            border: '1px solid color-mix(in srgb, var(--danger) 40%, var(--border))',
                            color: 'var(--danger)',
                          }}>
                            {c.last_sync_error || 'The provider no longer accepts this connection.'}
                            {' '}Syncing stays stopped until it is connected again.
                            {/* Both ways out, side by side and where the problem is stated — this is one
                                of the few things on a card that is actually asking to be acted on, and
                                leaving the only remedies in the ⋯ menu made the notice a dead end.
                                Disconnect is offered *as well as* reconnect because it is sometimes the
                                only one available, and because even a successful fresh connect leaves
                                this row behind to be cleaned up. */}
                            <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                              {/* Repair, not re-connect: it reopens the bank's own sign-in against the
                                  connection that already exists, so the card keeps its accounts, mapping
                                  and fetched history, where "+ Connect" would start a second connection
                                  beside it. Hidden without a stored credential — there is no Item to
                                  re-authorize, so the button could only ever fail. */}
                              {p.provider === 'plaid' && c.has_credential !== false ? (
                                <Tooltip describeTrigger content={connectTitle}>
                                  <Button disabled={connectDisabled} onClick={() => reconnect(c)}>
                                    Reconnect this bank
                                  </Button>
                                </Tooltip>
                              ) : null}
                              <Button variant="secondary" onClick={() => setDisconnectTarget({
                                provider: p.provider,
                                external_id: c.external_id,
                                institution: c.institution,
                                // With nothing stored there is nothing to revoke *with*, so the
                                // confirmation must not promise the access ends — see the dialog copy.
                                revokes: p.revokes_on_disconnect !== false && c.has_credential !== false,
                                hasCredential: c.has_credential !== false,
                              })}>
                                Disconnect
                              </Button>
                            </div>
                          </div>
                        ) : null}
                        {/* Outcome and totals, with the per-account chips behind the "Last sync"
                            disclosure. Shown outright they made this card two lists of the same
                            accounts, one from the provider and one local, and a seven-account
                            connection fifteen rows tall. */}
                        <LastSyncSummary
                          lastSync={c.last_sync}
                          syncing={!!c.syncing}
                          providerAccounts={openSyncDetails[c.id] ? providerAccountsByConnection[c.id] : undefined}
                          detailOpen={!!openSyncDetails[c.id]}
                          onToggleDetail={providerAccountsByConnection[c.id]?.length
                            ? () => setOpenSyncDetails(prev => ({ ...prev, [c.id]: !prev[c.id] }))
                            : null}
                          onOpenReport={() => openLastSyncReport(c)}
                          onOpenLog={() => setSyncLogScope({ subjects: [c.id] })}
                        />
                        {accts.length || unfedProviderAccounts(c).length ? (() => {
                          const unfed = unfedProviderAccounts(c)
                          const total = accts.length + unfed.length
                          const open = !!openAccountLists[c.id]
                          return (
                            <button
                              type="button"
                              onClick={() => setOpenAccountLists(prev => ({ ...prev, [c.id]: !open }))}
                              style={{
                                display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
                                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                                font: 'inherit', fontSize: 12, color: 'var(--muted)',
                              }}
                              title={open ? 'Hide the accounts this connection feeds' : 'Show the accounts this connection feeds'}
                            >
                              <span aria-hidden style={{ fontSize: 10 }}>{open ? '▾' : '▸'}</span>
                              <span>Accounts ({total})</span>
                              {/* Survives the collapse deliberately: an account with no destination is
                                  skipped by every sync until it is resolved, and a nudge only visible
                                  after expanding is one that will not be seen. */}
                              {unfed.length ? (
                                <span style={{ color: 'var(--accent2)', fontWeight: 600 }}>
                                  · {unfed.length} with no destination
                                </span>
                              ) : null}
                            </button>
                          )
                        })() : null}
                        {openAccountLists[c.id] && accts.length ? accts.map(a => (
                          <div key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--muted)' }}>
                            <span style={{ color: 'var(--text)' }}>{a.display_name || a.name}</span>
                            {a.mask ? <span>····{a.mask}</span> : null}
                            {/* One credential can cover several banks (a SimpleFIN access URL does), so the
                                card's own institution name does not identify which bank an account is at.
                                Shown only when it adds something the card heading doesn't already say. */}
                            {institutionByAccountId[a.id] && institutionByAccountId[a.id] !== c.institution ? (
                              <span style={{ fontSize: 11 }}>{institutionByAccountId[a.id]}</span>
                            ) : null}
                            {/* Named because a merged account is otherwise indistinguishable here from a
                                standalone one, and the group is where its transactions are read. */}
                            {a.parent_account_id ? (
                              <span style={{ fontSize: 11 }}>
                                in {accountLabelById.get(a.parent_account_id) || 'a merged group'}
                              </span>
                            ) : null}
                            {/* Last, after every part of the account's identity. It used to sit between the
                                mask and the bank name, which put a control in the middle of a name — the
                                row read as "Rewards Card ····4417 ↗ Harborline Bank" and the arrow
                                looked like punctuation rather than a button. Same launcher the Accounts
                                page uses, opening the same panel: a connection's account list is a place
                                a user wants to go *look at* the account from. */}
                            <IconButton
                              size="compact"
                              tone="accent"
                              onClick={() => openAccountDetail({
                                id: a.id, name: a.display_name || a.name, mask: a.mask,
                              })}
                              aria-label={`View ${a.display_name || a.name}`}
                            >↗</IconButton>
                          </div>
                        )) : null}
                        {/* Named in the provider's own words, because that is what the user chose from at
                            the bank and the local account may since have been renamed. Without these the
                            list answers "what is Luma importing?" while looking like it answers "what did
                            I share?" — and a skipped account, which appears nowhere else in the app, is
                            silently missing from it. */}
                        {openAccountLists[c.id] ? unfedProviderAccounts(c).map(pa => (
                          <div key={pa.external_account_id}
                            style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--muted)' }}>
                            <span>{pa.label}</span>
                            <span style={{ fontSize: 11, fontStyle: 'italic' }}>
                              {pa.mapping_mode === 'skip' ? 'not imported (skipped)' : 'not imported yet'}
                            </span>
                          </div>
                        )) : null}
                        {!accts.length && !unfedProviderAccounts(c).length ? (
                          // One empty state now, not two. This used to also cover "accounts are here but
                          // undecided", which needed the mapping step rather than a refresh — those rows
                          // are listed above as *not imported yet*, so reaching this text means the
                          // provider account list is genuinely empty and there is nothing to map.
                          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                            {c.has_credential === false
                              // Refreshing needs a credential to fetch with, so for a connection whose
                              // credential is gone the old advice was a step that could only fail.
                              ? 'No accounts, and no stored credential to fetch them with — connect this provider again, then disconnect this connection.'
                              : 'No accounts imported yet — pull them in with ⋯ → “↻ Refresh accounts”.'}
                          </span>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0, lineHeight: 1.6 }}>
                  {/* The sandbox note only makes sense for a provider that has one; for the rest it would
                      describe a mode they cannot be in. */}
                  {p.env === 'sandbox'
                    ? 'Running in Sandbox — use the provider’s test credentials when the connect dialog opens. Switch to Production on Configure once you’re ready for real accounts.'
                    : 'Connect an account to keep balances and transactions in sync.'}
                </p>
              )}
            </div>
          </SectionCard>
        )
      })}

      {/* Adding a data provider means whatever its first step actually is: entering app credentials for a
          provider that has them, and connecting straight away for one that has none — for which a
          Configure dialog would open with nothing in it. Providers needing credentials stay admin-only;
          one that needs none is gated on the vault like any other connect. */}
      {unconfigured.length && unconfigured.some(p => isAdmin || p.requires_app_config === false) ? (
        <Card style={{ padding: '12px 16px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>Add a data provider:</span>
          {unconfigured
            .filter(p => isAdmin || p.requires_app_config === false)
            .map(p => (
              <Button key={p.provider} variant="secondary"
                onClick={() => (p.requires_app_config === false ? connect(p) : openConfig(p))}>
                + {providerLabel(p.provider)}
              </Button>
            ))}
        </Card>
      ) : null}

      {connectTarget ? (
        <TokenConnectDialog
          provider={connectTarget.provider}
          spec={connectTarget.connect_spec}
          relinkCandidates={relinkCandidates(connectTarget)}
          describeConnection={c => connectionAccountsLabel(
            accountsForConnectionId(c.id).map(a => a.display_name || a.name),
          )}
          historyDays={historyDays}
          onConnect={(token, days, adopt) => connectWithToken(connectTarget.provider, token, days, adopt)}
          onClose={() => setConnectTarget(null)}
        />
      ) : null}

      {configTarget ? (
        <ProviderConfigDialog
          provider={configTarget.provider}
          initial={configTarget}
          onSave={(payload) => saveConfig(configTarget.provider, payload)}
          ensureVault={ensureVault}
          onClose={() => setConfigTarget(null)}
        />
      ) : null}

      {vaultSettingsOpen ? (
        <VaultSettingsDialog
          currentUserId={currentUser?.id}
          isAdmin={isAdmin}
          onChangePassphrase={() => { setVaultSettingsOpen(false); changePassphrase() }}
          onChanged={refresh}
          onClose={() => setVaultSettingsOpen(false)}
        />
      ) : null}

      {vaultRecoveryOpen ? (
        // Both outcomes change vault state the page reads — a recovery leaves it unlocked, a reset
        // leaves it unconfigured — so both refresh through the same path the other vault dialogs use
        // rather than each patching a flag locally.
        <VaultRecoveryDialog
          onRecovered={refresh}
          onReset={refresh}
          onClose={() => { setVaultRecoveryOpen(false); refresh() }}
        />
      ) : null}

      {disconnectTarget ? (
        <AppConfirmDialog
          title={`Disconnect ${disconnectTarget.institution || 'this bank'}?`}
          // Two materially different outcomes, so they get two different sentences. Where the provider can
          // be told to revoke, disconnecting really does end the access. Where it cannot, only Luma's copy
          // of the credential goes and the credential itself stays live — saying otherwise would leave
          // someone believing they had cut off access they still have.
          // Three outcomes, not two, and the third is the one a user would otherwise be told wrongly.
          // Without a stored credential nothing can be sent to the provider at all — so this promises
          // only the local removal, and says the access may still be live, which for a provider that
          // *can* revoke is the difference between finished and one step left.
          description={!disconnectTarget.hasCredential
            ? `This removes the connection from Luma. Existing accounts and their transactions are kept. There is no stored credential left for it, so nothing can be revoked from here — if ${providerLabel(disconnectTarget.provider)} still lists this connection, remove it there too.`
            : disconnectTarget.revokes
              // Revoking the bank's token leaves Luma's own app credential in force, so a provider that has
              // one is named as still reachable, with where that access is revoked.
              ? providerById[disconnectTarget.provider]?.requires_app_config !== false
                ? `This revokes the connection at the provider, so it can no longer pull transactions (and any leaked copy of the token also stops working). Existing accounts, their transactions and Luma's access to ${providerLabel(disconnectTarget.provider)} are kept. Reconnecting later means linking the bank again. Luma's access to ${providerLabel(disconnectTarget.provider)} can be revoked only by signing into the ${providerLabel(disconnectTarget.provider)} Dashboard.`
                : 'This revokes the connection at the provider, so it can no longer pull transactions (and any leaked copy of the token also stops working). Existing accounts and their transactions are kept. Reconnecting later means linking the bank again.'
              : `This removes the connection from Luma, so it stops pulling transactions here. Existing accounts and their transactions are kept. ${providerLabel(disconnectTarget.provider)} has no way to revoke a credential from another app, so the access itself stays valid until it is revoked at the provider.`}
          confirmLabel={disconnecting ? 'Disconnecting…' : 'Disconnect'}
          confirmDisabled={disconnecting}
          cancelDisabled={disconnecting}
          onConfirm={confirmDisconnect}
          onCancel={() => setDisconnectTarget(null)}
        />
      ) : null}

      {revokeRefused ? (
        <AppConfirmDialog
          title="The provider refused to revoke this connection"
          description={`${revokeRefused.message} Removing it here deletes the connection from Luma and keeps its accounts and transactions, but does not end its access at ${providerLabel(revokeRefused.target.provider)}. That access may still be live; revoke it from the provider's dashboard or the institution's website.`}
          borderColor="var(--warning)"
          confirmLabel={disconnecting ? 'Removing…' : 'Remove anyway'}
          confirmDisabled={disconnecting}
          cancelDisabled={disconnecting}
          onConfirm={removeWithoutRevoking}
          onCancel={() => setRevokeRefused(null)}
        />
      ) : null}

      {/* Grouped by what the action is for: the mapping decision, then the two provider re-pulls, then
          the two that take something away. Only Disconnect is styled danger — it revokes the token at
          the provider, so coming back means a fresh Link the bank (or the plan) may not grant. Removing
          synced transactions reads more destructive than it is: the cursor reset is what makes the next
          sync pull the same history back, so its red belongs on the confirm button, not here. */}
      {cardMenu ? (
        <ActionMenu
          anchorElement={cardMenu.anchorElement}
          onClose={() => setCardMenu(null)}
          minWidth={220}
          items={[
            {
              label: 'Connection settings…',
              title: 'Choose what each account from this connection maps to — an existing account, a new one, or skipped — and which details future syncs capture. The mapping is also how Luma recognizes transactions already imported from a file.',
              onClick: () => openAccountMap(cardMenu.connection),
            },
            {
              label: '↻ Fetch more history',
              separatorBefore: true,
              title: 'Pull older transactions for this connection — requests all available history from the provider and imports anything earlier than what’s already here. A bank or plan may cap how far back it will return.',
              onClick: () => fetchMoreHistory(cardMenu.provider, cardMenu.connection),
            },
            {
              label: '↻ Refresh accounts',
              title: 'Rebuild this connection’s accounts from its saved credential (no re-linking), then sync. Use this if the accounts are missing — e.g. after restoring a backup. To pull older transactions, use Fetch more history.',
              onClick: () => refreshConnectionAccounts(cardMenu.provider, cardMenu.connection),
            },
            {
              label: 'Remove synced transactions',
              separatorBefore: true,
              title: 'Delete every transaction this connection has synced and reset how far it has pulled, so the next sync re-imports that history from the provider. The connection, its accounts, and their mapping are kept.',
              onClick: () => openRemoveSynced(cardMenu.connection),
            },
            {
              label: 'Disconnect',
              danger: true,
              title: providerById[cardMenu.provider]?.revokes_on_disconnect === false
                ? 'Remove this connection from Luma. Existing accounts and transactions are kept. This provider has no way to revoke a credential from here, so revoking it means going to the provider.'
                : 'Revoke this connection at the provider. Existing accounts and transactions are kept, but reconnecting means linking the bank again.',
              onClick: () => setDisconnectTarget({
                provider: cardMenu.provider,
                external_id: cardMenu.connection.external_id,
                institution: cardMenu.connection.institution,
                revokes: providerById[cardMenu.provider]?.revokes_on_disconnect !== false
                  && cardMenu.connection.has_credential !== false,
                hasCredential: cardMenu.connection.has_credential !== false,
              }),
            },
          ]}
        />
      ) : null}


      {mapTarget ? (
        <ConnectionAccountMapDialog
          connection={mapTarget.connection}
          providerAccounts={mapTarget.accounts}
          captureFields={mapTarget.captureFields}
          accounts={accounts}
          onToggleCaptureField={toggleCaptureField}
          loading={mapLoading}
          saving={mapSaving}
          error={mapError}
          requireAll={mapTarget.pendingBackfill}
          onSave={saveAccountMap}
          onClose={() => { setMapTarget(null); setMapError(null) }}
        />
      ) : null}

      {notice ? (
        <AppNoticeDialog title={notice.title} description={notice.description} onClose={() => setNotice(null)} />
      ) : null}
    </div>
    {/* Outside the grid above: these float over the app rather than sitting in the tab's column. */}
    {connectionDialogsNode}
    {panelsNode}
    {accountDetailPanelsNode}
    {syncLogScope ? (
      <ConnectionSyncLogDialog
        initialConnectionIds={syncLogScope.subjects}
        initialProviders={syncLogScope.providers}
        onClose={() => setSyncLogScope(null)}
      />
    ) : null}
    </>
  )
}
