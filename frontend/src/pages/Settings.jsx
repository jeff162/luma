// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Settings: every preference and piece of housekeeping, grouped by what it is about — the person using
 * the app, the ledger's data, and the server — rather than by who may change it. Someone looking for
 * Backup finds it with the rest of the data.
 *
 * Who may change it still decides what is listed. A section behind `require_admin_or_local` is listed
 * only for someone who may use it (`canAdminister`), so a member is not shown controls that would all be
 * refused; the server refuses them either way. About's update check is the one item that straddles the
 * line, and hides its admin half in place.
 */

import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { useAppSession } from '../lib/AppSessionContext.jsx'
import { useErrorLog } from '../lib/useErrorLog.js'
import { useServerCertificate } from '../lib/serverCertificate.js'
import { formatBytes, formatShare } from '../lib/storageFormat.js'
import { RefreshButton } from '../components/ui.jsx'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import SectionListPage, { Subsection, useSectionParam } from '../components/SectionListPage.jsx'
import BackupRestoreSection from '../components/administration/BackupRestoreSection.jsx'
import UserAdminSection from '../components/administration/UserAdminSection.jsx'
import { AccountSecuritySection } from '../components/administration/AccountSecuritySection.jsx'
import SecurityChecklistSection from '../components/administration/SecurityChecklistSection.jsx'
import { ServerCertificateSection } from '../components/ServerCertificate.jsx'
import ConfigurationSection from '../components/administration/ConfigurationSection.jsx'
import ErrorLogSection from '../components/administration/ErrorLogSection.jsx'
import DeveloperOptionsSection from '../components/administration/DeveloperOptionsSection.jsx'
import ThemeSection from '../components/settings/ThemeSection.jsx'
import CurrencySection from '../components/settings/CurrencySection.jsx'
import SignInFactorsSection from '../components/settings/SignInFactorsSection.jsx'
import ImportStorageSection from '../components/settings/ImportStorageSection.jsx'
import { DismissedDuplicatePairsSection, DistinctAccountPairsSection } from '../components/settings/DuplicateExceptionSections.jsx'
import {
  BackupHistoryTrashSection, RulesTrashSection, TransactionsTrashSection, DuplicateTransactionsTrashSection,
} from '../components/settings/TrashSections.jsx'
import AboutSection from '../components/settings/AboutSection.jsx'

const ERROR_LOG_SECTION = 'errorLog'

export default function Settings() {
  const {
    authEnabled,
    canAdminister,
    currentUser,
    passwordPolicy,
    setPasswordPolicy,
    activeLocalProfile,
    developerOptionsEnabled,
    dbInstanceId,
    bundledLicenseAvailable,
    buildStamp,
    thirdPartyNoticesScope,
  } = useAppSession()

  // Read here rather than inside the section so its refresh can sit on the section's title, where every
  // refresh control goes. It still reads only while the section is open.
  const requestedSection = useSectionParam()
  const errorLog = useErrorLog(canAdminister && requestedSection === ERROR_LOG_SECTION)
  const [serverCertificate, setServerCertificate] = useServerCertificate()

  // What the two housekeeping sections hold, read once here so the list can say it before either is
  // opened, and again whenever one of them changes it. A failed read leaves the names without figures.
  const [storage, setStorage] = useState(null)
  const loadStorage = useCallback(() => {
    api.getStorageSummary().then(setStorage).catch(() => { })
  }, [])
  useEffect(() => { loadStorage() }, [loadStorage])
  const trash = storage?.trash
  const trashTotal = trash ? trash.transactions + trash.duplicates + trash.rules + (trash.backup_history || 0) : 0
  const detailBytes = storage?.import_detail?.bytes || 0
  const detailShare = formatShare(detailBytes, storage?.database_bytes).replace('about ', '')
  const counted = (title, count) => (trash ? `${title} (${count.toLocaleString()})` : title)

  const groups = [
    {
      title: 'Personal',
      sections: [
        {
          key: 'appearance',
          title: 'Appearance',
          description: 'Select the color theme.',
          content: <ThemeSection />,
        },
        // With sign-in protection off there is no sign-in for a passkey or a second factor to belong to.
        authEnabled && {
          key: 'signInMethods',
          title: 'Security',
          description: 'The password, passkeys and two-factor sign-in of the user signed in.',
          help: <FeatureExplainer topic="account-security" placement="bottom-left" />,
          content: <SignInFactorsSection passwordPolicy={passwordPolicy} />,
        },
      ],
    },
    {
      title: 'Data',
      sections: [
        canAdminister && {
          key: 'backup',
          title: 'Backup / Restore',
          help: <FeatureExplainer topic="data-and-backups" placement="bottom-left" />,
          content: <BackupRestoreSection />,
        },
        {
          key: 'trash',
          title: 'Trash',
          note: trashTotal ? trashTotal.toLocaleString() : '',
          content: (
            <div style={{ display: 'grid', gap: 18 }}>
              <Subsection title={counted('Transactions', trash?.transactions)}>
                <TransactionsTrashSection count={trash?.transactions} onChanged={loadStorage} />
              </Subsection>
              <Subsection title={counted('Duplicate transactions', trash?.duplicates)}>
                <DuplicateTransactionsTrashSection count={trash?.duplicates} onChanged={loadStorage} />
              </Subsection>
              <Subsection title={counted('Rules', trash?.rules)}>
                <RulesTrashSection onChanged={loadStorage} />
              </Subsection>
              {/* The backup history is an administrator's, so only they are shown or counted its trash. */}
              {canAdminister ? (
                <Subsection title={counted('Backup history', trash?.backup_history ?? 0)}>
                  <BackupHistoryTrashSection onChanged={loadStorage} />
                </Subsection>
              ) : null}
            </div>
          ),
        },
        {
          key: 'importStorage',
          title: 'Import storage',
          note: detailBytes ? [formatBytes(detailBytes), detailShare].filter(Boolean).join(' · ') : '',
          description: 'The record each import keeps of the rows it refused, and the space it uses.',
          content: <ImportStorageSection storage={storage} onChanged={loadStorage} />,
        },
        {
          key: 'duplicateExceptions',
          title: 'Duplicate detection exceptions',
          content: (
            <div style={{ display: 'grid', gap: 18 }}>
              {/* Each list explains itself in its own card, so neither takes a description here. */}
              <Subsection title="Dismissed duplicate pairs"><DismissedDuplicatePairsSection /></Subsection>
              <Subsection title="Distinct account pairs"><DistinctAccountPairsSection /></Subsection>
            </div>
          ),
        },
        {
          key: 'currency',
          title: 'Currency',
          description: 'Define the currency used by the ledger.',
          help: <FeatureExplainer topic="single-currency" placement="bottom-left" />,
          content: <CurrencySection />,
        },
      ],
    },
    // The install and the network perimeter (`security-model.md` → *Identity and the network perimeter*).
    canAdminister && {
      title: 'Server',
      sections: [
        // With sign-in protection off there are no users to manage, only the local profiles.
        authEnabled && {
          key: 'userManagement',
          title: 'User management',
          description: 'Manage who can sign in.',
          content: <UserAdminSection passwordPolicy={passwordPolicy} />,
        },
        {
          key: 'signInProtection',
          title: 'Sign-in protection',
          description: 'Whether opening this installation requires signing in, and the password requirements.',
          help: <FeatureExplainer topic="account-security" placement="bottom-left" />,
          content: (
            <AccountSecuritySection
              authEnabled={authEnabled}
              activeLocalProfile={activeLocalProfile}
              passwordPolicy={passwordPolicy}
              onPasswordPolicyChange={setPasswordPolicy}
            />
          ),
        },
        {
          key: 'securityChecklist',
          title: 'Security checklist',
          description: 'This installation compared with the recommended security practices.',
          help: <FeatureExplainer topic="security-checklist" placement="bottom-left" />,
          content: <SecurityChecklistSection />,
        },
        // Only where a reverse proxy on the server has a certificate to hand out.
        serverCertificate && {
          key: 'serverCertificate',
          title: 'Server certificate',
          description: 'The certificate each computer installs so its browser trusts this server.',
          content: <ServerCertificateSection certificate={serverCertificate} onChange={setServerCertificate} />,
        },
        {
          key: 'configuration',
          title: 'Startup configuration',
          help: <FeatureExplainer topic="configuration" placement="bottom-left" />,
          content: <ConfigurationSection authEnabled={authEnabled} currentUser={currentUser} />,
        },
        {
          key: ERROR_LOG_SECTION,
          title: 'Error log',
          description: 'Errors the server recorded, newest first, for when something did not work and the screen did not say why.',
          refresh: <RefreshButton onRefresh={errorLog.load} loading={errorLog.loading} />,
          content: <ErrorLogSection log={errorLog.log} error={errorLog.error} />,
        },
      ],
    },
    {
      sections: [
        canAdminister && developerOptionsEnabled && {
          key: 'developerOptions',
          title: 'Developer options',
          description: 'Useful tools for developers and testing workflows.',
          content: <DeveloperOptionsSection authEnabled={authEnabled} />,
        },
      ],
    },
  ].filter(Boolean)

  // Looked up rather than set, so it sits on the title row instead of in the list.
  const headerSections = [
    {
      key: 'about',
      title: 'About',
      description: 'Version and installation details.',
      content: (
        <AboutSection
          dbInstanceId={dbInstanceId}
          bundledLicenseAvailable={bundledLicenseAvailable}
          buildStamp={buildStamp}
          thirdPartyNoticesScope={thirdPartyNoticesScope}
          canManageEnvironment={canAdminister}
        />
      ),
    },
  ]

  return (
    <SectionListPage
      title="Settings"
      help={<FeatureExplainer topic="page-settings" placement="bottom-left" />}
      groups={groups}
      headerSections={headerSections}
    />
  )
}
