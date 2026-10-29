// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useCallback } from 'react'
import { api } from '../../lib/api.js'
import { useAppSession } from '../../lib/AppSessionContext.jsx'
import { Card, Spinner, InsetPanel, SectionEyebrow, AppConfirmDialog, Toggle, Tooltip } from '../ui.jsx'
import { useUserPreference } from '../../lib/UserPreferencesContext.jsx'
import { NAV_DATA_LOCATION_PREF_KEY } from '../../lib/dataLocation.js'

// The configuration report: every resolved setting and which layer supplied it. Read-only on purpose.
// Settings that can be changed in the app have their own sections (sign-in, security profile, currency,
// data-source credentials); what remains here is resolved before the app is running — database
// locations, ports, the developer gate — so the honest thing to show is the effective value and its
// origin, not a form that cannot take effect. A plain install needs no `.env` file at all: defaults
// cover it, and the session secret is generated once and kept in the control database.
const CONFIG_SOURCE_LABELS = {
  default: 'Default',
  app_setting: 'Stored',
  env: 'Set in environment',
  derived: 'Derived',
}

function configSourceLabel(row) {
  if (row.source === 'env') return row.from_env_file ? 'Set in .env' : CONFIG_SOURCE_LABELS.env
  return CONFIG_SOURCE_LABELS[row.source] || row.source
}

// Each row is its own grid, so a content-sized label column is measured per row and no two rows agree on
// where the value starts. One shared width is what lines the value and source columns up down the whole
// panel. It is sized for the longest label and the longest variable name (LUMA_BACKEND_READY_TIMEOUT);
// anything longer added later wraps within the column rather than pushing the rows out of alignment.
const CONFIG_LABEL_COLUMN_PX = 210
// A derived row is indented, so its label column gives back exactly the indent — otherwise everything to
// its right would sit one indent off the lines the rest of the panel shares.
const CONFIG_DERIVED_INDENT_PX = 18

const CONFIG_PILL_STYLE = {
  display: 'inline-flex', alignItems: 'center',
  borderRadius: 99, padding: '2px 8px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
  border: '1px solid var(--border)',
}

// Smaller than the source chip beside it, deliberately: the chip is the row's answer to "what is in
// effect", which every row has, while this is a rare correction most installations never need. The hint
// carries the reason to press it, since neither "Reset" nor "Regenerate" says when it would be wanted.
function ConfigRowAction({ label, hint, disabled, onClick }) {
  return (
    <Tooltip describeTrigger content={hint}>
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        style={{
          ...CONFIG_PILL_STYLE,
          padding: '0 6px',
          fontSize: 10,
          background: 'transparent',
          color: 'var(--muted)',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.6 : 1,
        }}
      >
        {label}
      </button>
    </Tooltip>
  )
}

function ConfigSourceChip({ row }) {
  const overridden = row.source === 'env'
  return (
    <span style={{
      ...CONFIG_PILL_STYLE,
      background: overridden ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'var(--surface2)',
      color: overridden ? 'var(--accent)' : 'var(--muted)',
    }}>
      {configSourceLabel(row)}
    </span>
  )
}

/*
 * A value computed from another setting (the database paths, which follow the data directory) renders
 * indented under the setting it follows, and never names an environment variable unless that variable is
 * what supplied it — naming it otherwise advertises the per-file database overrides as ordinary knobs
 * when they exist only for a database that is not on the default filename.
 */
function orderedConfigRows(settings) {
  const children = new Map()
  for (const row of settings) {
    if (!row.derived_from) continue
    if (!children.has(row.derived_from)) children.set(row.derived_from, [])
    children.get(row.derived_from).push(row)
  }
  const ordered = []
  for (const row of settings) {
    if (row.derived_from) continue
    ordered.push(row)
    ordered.push(...(children.get(row.key) || []))
  }
  return ordered
}

/*
 * Most of these settings are read once at startup by an operator who will never look at them; the two
 * an ordinary install might change (the data directory and the port) would otherwise be buried
 * among them. A setting is filed as advanced by declaration rather than by whether it currently holds
 * its default — placement that moved with the value would make a row people saw last week vanish this
 * week — but one actually set in the environment is surfaced anyway, since overriding it is direct
 * evidence this installation cares about it. A derived row follows its parent so it is never orphaned
 * from the setting it explains.
 */
function splitConfigRows(rows) {
  const primary = []
  const advanced = []
  let bucketForParent = primary
  for (const row of rows) {
    if (row.derived_from) {
      bucketForParent.push(row)
      continue
    }
    bucketForParent = !row.advanced || row.source === 'env' ? primary : advanced
    bucketForParent.push(row)
  }
  return { primary, advanced }
}

/*
 * A stored value is otherwise permanent: it is written once and the environment cannot un-write it. The
 * one action offered here forgets it, so the current derivation (or a freshly generated secret) applies
 * at the next start. It is a reset rather than an edit because both settings that can reach it derive or
 * generate themselves — there is no value worth typing — and because everything on this panel is read at
 * startup, so a field accepting input that visibly does nothing until a restart reads as broken.
 */
function ConfigRow({ row, onReset, resetting }) {
  const derived = !!row.derived_from
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `minmax(0, ${derived ? CONFIG_LABEL_COLUMN_PX - CONFIG_DERIVED_INDENT_PX : CONFIG_LABEL_COLUMN_PX}px) minmax(0, 1fr) auto`,
        gap: 12,
        alignItems: 'baseline',
        padding: '10px 12px',
        borderRadius: 8,
        background: 'var(--surface2)',
        marginLeft: derived ? CONFIG_DERIVED_INDENT_PX : 0,
        borderLeft: derived ? '2px solid var(--border)' : undefined,
      }}
    >
      <div style={{ display: 'grid', gap: 3 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{row.label}</div>
        {row.env_var ? (
          <code style={{ fontSize: 11, color: 'var(--muted)', overflowWrap: 'anywhere' }}>{row.env_var}</code>
        ) : null}
      </div>
      <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', wordBreak: 'break-all' }}>
          {row.redacted ? (row.is_set ? 'Set' : 'Not set') : row.value}
          {/* The literal value is what appears in `.env`, so the absolute form accompanies it rather
              than replacing it — and only when the two actually differ. */}
          {row.absolute_value ? (
            <span style={{ color: 'var(--muted)' }}> ({row.absolute_value})</span>
          ) : null}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{row.help}</div>
      </div>
      <div style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
        {row.resettable ? (
          <ConfigRowAction
            label={row.redacted ? 'Regenerate' : 'Reset'}
            hint={configResetPrompt(row).hint}
            disabled={resetting}
            onClick={() => onReset(row)}
          />
        ) : null}
        <ConfigSourceChip row={row} />
      </div>
    </div>
  )
}

// Both resets sign every session out, so the confirm says that in the words of the setting rather than
// naming the mechanism.
function configResetPrompt(row) {
  if (row.key === 'session_secret') {
    return {
      title: 'Regenerate the session secret?',
      description: 'A new secret is generated at the next backend start. Every signed-in session is invalidated, so everyone has to sign in again. Worth doing if the secret may have been exposed — in a shared backup, for instance.',
      confirmLabel: 'Regenerate secret',
      hint: 'Replace the signing secret at the next restart — worth doing if it may have been exposed, such as in a shared backup. Everyone signs in again.',
    }
  }
  return {
    title: `Reset ${row.label.toLowerCase()}?`,
    description: `The stored value is forgotten and the default applies at the next backend start. Renaming the session cookie signs everyone out, so this takes effect once the backend restarts.`,
    confirmLabel: 'Reset to default',
    hint: 'Forget the stored value so the current default applies at the next restart — useful when it was stored under an older rule, or copied in from a database that has moved.',
  }
}

/*
 * Whether the navigation pane names the database this copy is open on.
 *
 * It lives on this panel rather than under Appearance for two reasons. This is where the database
 * locations are read, so it is where someone thinks "I want that where I can see it" — and the section
 * is already admin-or-local, which is the same audience the line itself is served to, so one gate covers
 * the control and the thing it controls instead of two rules that could drift.
 *
 * It is a *preference*, not a configured value, and is presented as one: ruled off from the rows above
 * and carrying no source chip, because no layer supplied it and nothing resolves it at startup. Stored
 * per user rather than as an app setting for the same reason — a stored setting would need an
 * environment variable that would then outrank the switch, which is not what a display toggle should do.
 */
function DataLocationNavToggle({ dataLocation }) {
  const [showDataLocation, setShowDataLocation] = useUserPreference(
    NAV_DATA_LOCATION_PREF_KEY, !!dataLocation?.show_by_default,
  )
  if (!dataLocation) return null
  return (
    <div style={{ borderTop: '1px solid var(--border)', display: 'grid', gap: 6, paddingTop: 12 }}>
      <Toggle
        checked={showDataLocation}
        onChange={setShowDataLocation}
        label="Show the data location in the navigation pane"
      />

    </div>
  )
}

export default function ConfigurationSection({ authEnabled, currentUser }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [config, setConfig] = useState({ settings: [], env_file_path: '', env_file_present: false })
  const [pendingReset, setPendingReset] = useState(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [resettingKey, setResettingKey] = useState('')
  const [notice, setNotice] = useState('')

  const { dataLocation } = useAppSession()

  const canManage = !authEnabled || currentUser?.role === 'admin'

  const load = useCallback(async () => {
    const resp = await api.getEffectiveConfig()
    setConfig({
      settings: resp.settings || [],
      env_file_path: resp.env_file_path || '',
      env_file_present: !!resp.env_file_present,
    })
  }, [])

  useEffect(() => {
    if (!canManage) {
      setLoading(false)
      return
    }

    let cancelled = false
    async function loadInitial() {
      setLoading(true)
      try {
        await load()
        if (!cancelled) setError('')
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to load configuration')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadInitial()
    return () => { cancelled = true }
  }, [canManage, load])

  if (!canManage) return null

  const rowGroups = splitConfigRows(orderedConfigRows(config.settings))

  async function handleReset(row) {
    setPendingReset(null)
    setResettingKey(row.key)
    setError('')
    setNotice('')
    try {
      const result = await api.resetConfigValue(row.key)
      // The row still reads as stored until the backend restarts — the value in force was resolved at
      // startup — so the panel says what will happen rather than implying it already has.
      setNotice(result.pending_value
        ? `${row.label} will be ${result.pending_value} after the backend restarts.`
        : `${row.label} will be regenerated when the backend restarts. Everyone will need to sign in again.`)
      await load()
    } catch (err) {
      setError(err.message || 'Failed to reset the setting')
    } finally {
      setResettingKey('')
    }
  }

  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      {loading ? <Spinner /> : (
        <div style={{ display: 'grid', gap: 14, padding: 16 }}>
          <InsetPanel style={{ gap: 8 }}>
            <SectionEyebrow style={{ fontSize: 13, fontWeight: 600, textTransform: 'none', letterSpacing: '0.03em' }}>Configuration variables</SectionEyebrow>
            <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, margin: 0 }}>
              The defaults are suitable for many installations. Settings can be overridden with a
              {' '}<code>.env</code>;
              {' '}<code>env_example.txt</code> documents the settings. This is used
              mainly for changing the port or running multiple copies on one machine. Changes require a
              restart.
            </p>
            <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, margin: 0 }}>
              {config.env_file_present
                ? <>Overrides are being read from <code>{config.env_file_path}</code>.</>
                : <>No override file is present. One can be created at <code>{config.env_file_path}</code>.</>}
            </p>
          </InsetPanel>

          {error && (
            <div style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</div>
          )}
          {notice && (
            <div style={{ fontSize: 13, color: '#16a34a' }}>{notice}</div>
          )}

          <div style={{ display: 'grid', gap: 2 }}>
            {rowGroups.primary.map(row => (
              <ConfigRow
                key={row.key}
                row={row}
                onReset={setPendingReset}
                resetting={resettingKey === row.key}
              />
            ))}
          </div>

          <DataLocationNavToggle dataLocation={dataLocation} />

          {rowGroups.advanced.length > 0 ? (
            <div style={{ display: 'grid', gap: 2 }}>
              <button
                type="button"
                onClick={() => setShowAdvanced(value => !value)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'start',
                  background: 'transparent', border: 'none', padding: '4px 0',
                  color: 'var(--muted)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                }}
                aria-expanded={showAdvanced}
              >
                <span style={{ display: 'inline-block', transform: showAdvanced ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s' }}>›</span>
                Advanced
              </button>
              {showAdvanced ? rowGroups.advanced.map(row => (
                <ConfigRow
                  key={row.key}
                  row={row}
                  onReset={setPendingReset}
                  resetting={resettingKey === row.key}
                />
              )) : null}
            </div>
          ) : null}

          {pendingReset ? (
            <AppConfirmDialog
              {...configResetPrompt(pendingReset)}
              confirmVariant="danger"
              borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
              onConfirm={() => handleReset(pendingReset)}
              onCancel={() => setPendingReset(null)}
              width="min(520px, 100%)"
            />
          ) : null}
        </div>
      )}
    </Card>
  )
}
