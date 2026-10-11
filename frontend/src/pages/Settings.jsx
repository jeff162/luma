// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { APP_NAME } from '../lib/appConfig.js'
import { useAppSession } from '../lib/AppSessionContext.jsx'
import { PageHeader, RefreshButton } from '../components/ui.jsx'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import ErrorLogSection from '../components/administration/ErrorLogSection.jsx'
import ReviewFlaggingSection from '../components/settings/ReviewFlaggingSection.jsx'
import { useErrorLog } from '../lib/useErrorLog.js'
import { useUserPreference } from '../lib/UserPreferencesContext.jsx'
import UserAdminSection from '../components/administration/UserAdminSection.jsx'
import IntendedUsageSection from '../components/administration/IntendedUsageSection.jsx'
import { AccountSecuritySection } from '../components/administration/AccountSecuritySection.jsx'
import ConfigurationSection from '../components/administration/ConfigurationSection.jsx'
import DeveloperOptionsSection from '../components/administration/DeveloperOptionsSection.jsx'
import ThemeSection from '../components/settings/ThemeSection.jsx'
import CurrencySection from '../components/settings/CurrencySection.jsx'
import TransactionTagsSection from '../components/settings/TransactionTagsSection.jsx'
import ImportStorageSection from '../components/settings/ImportStorageSection.jsx'
import { DismissedDuplicatePairsSection, DistinctAccountPairsSection } from '../components/settings/DuplicateExceptionSections.jsx'
import { RulesTrashSection, TransactionsTrashSection, DuplicateTransactionsTrashSection } from '../components/settings/TrashSections.jsx'
import AboutSection from '../components/settings/AboutSection.jsx'

const SETTINGS_SECTIONS_PREF_KEY = 'ui.settings.stickySections'
// Stable default so the preference value keeps a constant identity when nothing is saved yet.
const EMPTY_SECTION_STATE = {}
const SETTINGS_CONTENT_WIDTH = 'min(1040px, 100%)'

function StickySection({ title, description, actions, refresh = null, children, defaultCollapsed = true, scrollContainerRef = null, open: controlledOpen, onOpenChange }) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(!defaultCollapsed)
  const sectionRef = useRef(null)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = onOpenChange ?? setUncontrolledOpen

  useEffect(() => {
    if (!open) return
    const node = sectionRef.current
    if (!node) return

    const scrollAfterLayout = () => {
      const scrollParent = scrollContainerRef?.current
      if (!scrollParent) {
        node.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
      }
      const padding = 12
      const sectionTop = node.offsetTop
      const sectionBottom = sectionTop + node.offsetHeight
      const viewTop = scrollParent.scrollTop
      const viewBottom = viewTop + scrollParent.clientHeight

      let targetTop = null

      if (sectionTop < viewTop + padding) {
        targetTop = Math.max(0, sectionTop - padding)
      }
      else if (sectionBottom > viewBottom - padding) {
        targetTop = Math.max(0, sectionBottom - scrollParent.clientHeight + padding)
      }

      if (targetTop !== null && Math.abs(targetTop - scrollParent.scrollTop) > 2) {
        scrollParent.scrollTo({ top: targetTop, behavior: 'smooth' })
      }
    }

    let timeoutId = null
    let frame2 = null
    // Wait until the expand/collapse layout settles before scrolling, or the
    // section can jump to the wrong spot using stale pre-expansion measurements.
    const frame = window.requestAnimationFrame(() => {
      frame2 = window.requestAnimationFrame(() => {
        timeoutId = window.setTimeout(scrollAfterLayout, 0)
      })
    })

    return () => {
      window.cancelAnimationFrame(frame)
      if (frame2 !== null) window.cancelAnimationFrame(frame2)
      if (timeoutId !== null) window.clearTimeout(timeoutId)
    }
  }, [open, scrollContainerRef])

  return (
    <section ref={sectionRef} style={{ marginBottom: 18, display: 'grid', justifyItems: 'stretch', width: '100%' }}>
      <div
        style={{
          padding: '4px 0 6px',
          width: 'min(100%, 420px)',
        }}
      >
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '8px 12px',
          border: '1px solid var(--border)',
          borderRadius: 16,
          background: open ? 'color-mix(in srgb, var(--surface) 78%, var(--surface2))' : 'var(--surface)',
          width: '100%',
          boxShadow: open ? '0 8px 24px rgba(15, 23, 42, 0.05)' : '0 1px 0 rgba(15, 23, 42, 0.03)',
          transition: 'background 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease',
        }}>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              background: 'none',
              border: 'none',
              padding: 0,
              margin: 0,
              color: 'inherit',
              cursor: 'pointer',
              textAlign: 'left',
              // Sized to its content rather than stretched, so a refresh can sit against the title; the
              // spacer below keeps the rest of the row a place to click open.
              flex: '0 1 auto',
              minWidth: 0,
            }}
          >
            <span style={{
              width: 20,
              height: 20,
              borderRadius: 999,
              border: '1px solid color-mix(in srgb, var(--border) 82%, transparent)',
              display: 'grid',
              placeItems: 'center',
              fontSize: 13,
              color: 'var(--muted)',
              background: open ? 'color-mix(in srgb, var(--surface2) 65%, var(--surface))' : 'var(--surface2)',
              lineHeight: 1,
              flexShrink: 0,
            }}>
              {open ? '-' : '+'}
            </span>
            <span style={{ display: 'grid', gap: description ? 2 : 0, minWidth: 0 }}>
              <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>{title}</span>
              {description ? <span style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.45 }}>{description}</span> : null}
            </span>
          </button>
          {/* Only while open: a closed section has nothing on screen to reload. */}
          {open && refresh ? <div style={{ flexShrink: 0 }}>{refresh}</div> : null}
          <div aria-hidden="true" onClick={() => setOpen(!open)} style={{ flex: 1, alignSelf: 'stretch', cursor: 'pointer' }} />
          {actions ? <div style={{ flexShrink: 0 }}>{actions}</div> : null}
        </div>
      </div>
      {open ? (
        <div
          style={{
            marginTop: 2,
            marginLeft: 12,
            width: 'calc(100% - 12px)',
            paddingLeft: 14,
            paddingBottom: 8,
            position: 'relative',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 10,
              width: 1,
              background: 'color-mix(in srgb, var(--border) 70%, transparent)',
              pointerEvents: 'none',
            }}
          />
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: 0,
              bottom: 0,
              width: 10,
              height: 10,
              borderLeft: '1px solid color-mix(in srgb, var(--border) 70%, transparent)',
              borderBottom: '1px solid color-mix(in srgb, var(--border) 70%, transparent)',
              borderBottomLeftRadius: 10,
              pointerEvents: 'none',
            }}
          />
          {children}
        </div>
      ) : null}
    </section>
  )
}

export default function Settings() {
  const {
    authEnabled,
    currentUser,
    passwordPolicy,
    securityProfile,
    dataProviderIntended,
    developerOptionsEnabled,
    dbInstanceId,
    bundledLicenseAvailable,
    buildStamp,
    thirdPartyNoticesScope,
    activeLocalProfile,
    setSecurityProfile,
    setPasswordPolicy,
    setDataProviderIntended,
  } = useAppSession()
  // Section open/closed state is a single user preference, read and written straight through the
  // context — no local mirror, no load/save effects, no localStorage, so there is nothing to drift.
  const [sectionOpenState, setSectionOpenState] = useUserPreference(SETTINGS_SECTIONS_PREF_KEY, EMPTY_SECTION_STATE)
  const settingsScrollRef = useRef(null)

  // Deep link from elsewhere in the app: `?section=<key>` opens that section on arrival (a link landing on
  // a collapsed card has not actually taken the user anywhere). Captured once, so re-collapsing the section
  // afterwards sticks instead of the URL springing it back. Opening writes through the normal section preference
  // rather than overriding the render: the section then behaves like any other, and "open" survives as
  // the user's state — which is right, since they just asked to look at it.
  const [searchParams] = useSearchParams()
  const [deepLink] = useState(() => ({
    section: searchParams.get('section') || '',
  }))
  const deepLinkSection = deepLink.section
  useEffect(() => {
    if (deepLinkSection) setSectionOpenState(prev => ({ ...prev, [deepLinkSection]: true }))
  }, [deepLinkSection, setSectionOpenState])

  function bindSection(sectionKey, defaultCollapsed = true) {
    const isOpen = sectionOpenState[sectionKey] ?? !defaultCollapsed
    return {
      open: isOpen,
      onOpenChange: value => setSectionOpenState(prev => ({ ...prev, [sectionKey]: value })),
    }
  }

  const canManageEnvironment = !authEnabled || currentUser?.role === 'admin'
  // Read here rather than inside the section so its refresh can sit on the section's title, where every
  // refresh control goes. It still reads only while the section is open.
  const errorLogSection = bindSection('errorLog')
  const errorLog = useErrorLog(canManageEnvironment && !!errorLogSection.open)

  return (
    <div data-browser-context-passthrough="true" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '24px 28px 0', flexShrink: 0 }}>
        <div style={{ width: SETTINGS_CONTENT_WIDTH, margin: '0 auto' }}>
          <PageHeader title="Settings" help={<FeatureExplainer topic="page-settings" placement="bottom-left" />} />
        </div>
      </div>

      <div data-browser-context-passthrough="true" ref={settingsScrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 28px 24px' }}>
        <div style={{ width: SETTINGS_CONTENT_WIDTH, margin: '0 auto' }}>

          <StickySection
            title="Appearance"
            description="Select the color theme."
            scrollContainerRef={settingsScrollRef}
            {...bindSection('appearance')}
          >
            <ThemeSection />
          </StickySection>

          <StickySection
            title="Currency"
            description="Define the currency used by the ledger."
            scrollContainerRef={settingsScrollRef}
            actions={<FeatureExplainer topic="single-currency" placement="bottom-left" />}
            {...bindSection('currency')}
          >
            <CurrencySection />
          </StickySection>

          <StickySection
            title="New transactions"
            description="Choose whether new transactions arrive flagged for review."
            scrollContainerRef={settingsScrollRef}
            actions={<FeatureExplainer topic="reviewing-transactions" placement="bottom-left" />}
            {...bindSection('newTransactions')}
          >
            <ReviewFlaggingSection />
          </StickySection>

          {/* Section key stays 'environment' through the rename so an existing expanded/collapsed
              preference is not silently reset. */}
          {canManageEnvironment && (
            <StickySection
              title="Configuration"
              scrollContainerRef={settingsScrollRef}
              actions={<FeatureExplainer topic="configuration" placement="bottom-left" />}
              {...bindSection('environment')}
            >
              <ConfigurationSection authEnabled={authEnabled} currentUser={currentUser} />
            </StickySection>
          )}

          {/* Behind the same gate as Configuration: a traceback can carry transaction details and this
              installation's file paths. */}
          {canManageEnvironment && (
            <StickySection
              title="Error log"
              description="Errors the server recorded, newest first, for when something did not work and the screen did not say why."
              scrollContainerRef={settingsScrollRef}
              refresh={<RefreshButton onRefresh={errorLog.load} loading={errorLog.loading} />}
              {...errorLogSection}
            >
              <ErrorLogSection log={errorLog.log} error={errorLog.error} />
            </StickySection>
          )}

          <StickySection
            title="Intended usage"
            description={`How ${APP_NAME} will be run and whether a bank or data provider will be connected which involves secrets that need protecting.`}
            actions={<FeatureExplainer topic="data-and-backups" placement="bottom-left" />}
            scrollContainerRef={settingsScrollRef}
            {...bindSection('intendedUsage')}
          >
            <IntendedUsageSection
              authEnabled={authEnabled}
              securityProfile={securityProfile}
              dataProviderIntended={dataProviderIntended}
              passwordPolicy={passwordPolicy}
              onProfileChange={value => setSecurityProfile?.(value)}
              onDataProviderChange={value => setDataProviderIntended?.(value)}
            />
          </StickySection>

          <StickySection
            title="Account security"
            description="Sign-in protection, password requirements, passkeys, and two-factor sign-in."
            actions={<FeatureExplainer topic="account-security" placement="bottom-left" />}
            scrollContainerRef={settingsScrollRef}
            {...bindSection('accountSecurity')}
          >
            <AccountSecuritySection
              authEnabled={authEnabled}
              currentUser={currentUser}
              activeLocalProfile={activeLocalProfile}
              passwordPolicy={passwordPolicy}
              onPasswordPolicyChange={setPasswordPolicy}
            />
          </StickySection>

          {authEnabled && currentUser?.role === 'admin' && (
            <StickySection
              title="User management"
              description={`Manage who can sign in.`}
              scrollContainerRef={settingsScrollRef}
              {...bindSection('userManagement')}
            >
              <UserAdminSection passwordPolicy={passwordPolicy} />
            </StickySection>
          )}

          {developerOptionsEnabled && (
            <StickySection
              title="Developer options"
              description="Useful tools for developers and testing workflows."
              scrollContainerRef={settingsScrollRef}
              {...bindSection('developerOptions')}
            >
              <DeveloperOptionsSection authEnabled={authEnabled} />
            </StickySection>
          )}

          <StickySection
            title="Dismissed duplicate pairs"
            description="Transaction pairs marked as two different charges rather than one recorded twice, so duplicate detection leaves them alone."
            scrollContainerRef={settingsScrollRef}
            {...bindSection('dismissedDuplicatePairs')}
          >
            <DismissedDuplicatePairsSection />
          </StickySection>

          <StickySection
            title="Distinct account pairs"
            description="Accounts which have declared to be distinct from one another to prevent imports from looking for duplicate transactions between them."
            scrollContainerRef={settingsScrollRef}
            {...bindSection('distinctAccountPairs')}
          >
            <DistinctAccountPairsSection />
          </StickySection>

          <StickySection
            title="Transaction tags"
            description="Labels applied to transactions to create selection criteria."
            actions={<FeatureExplainer topic="tags" placement="bottom-left" />}
            scrollContainerRef={settingsScrollRef}
            {...bindSection('transactionTags')}
          >
            <TransactionTagsSection />
          </StickySection>

          <StickySection
            title="Import storage"
            description="The record each import keeps of the rows it refused, and the space it uses."
            scrollContainerRef={settingsScrollRef}
            {...bindSection('importStorage')}
          >
            <ImportStorageSection />
          </StickySection>

          <StickySection
            title="Trash"
            scrollContainerRef={settingsScrollRef}
            {...bindSection('trash')}
          >
            <div style={{ display: 'grid', gap: 18 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                  Transactions
                </div>
                <TransactionsTrashSection />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                  Duplicate transactions
                </div>
                <DuplicateTransactionsTrashSection />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                  Rules
                </div>
                <RulesTrashSection />
              </div>
            </div>
          </StickySection>

          <StickySection
            title="About"
            description={`Version and installation details.`}
            scrollContainerRef={settingsScrollRef}
            {...bindSection('about')}
          >
            <AboutSection
              dbInstanceId={dbInstanceId}
              bundledLicenseAvailable={bundledLicenseAvailable}
              buildStamp={buildStamp}
              thirdPartyNoticesScope={thirdPartyNoticesScope}
              canManageEnvironment={canManageEnvironment}
            />
          </StickySection>
        </div>
      </div>
    </div>
  )
}
