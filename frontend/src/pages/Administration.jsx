// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Administration: what the server puts behind `require_admin_or_local` — the install and the network
 * perimeter, not the ledger. Everything a member may change is on Settings (`pages/Settings.jsx`).
 *
 * The navigation entry is absent for anyone else, and a member who arrives by a typed or remembered URL
 * is sent to Settings rather than shown a page of refusals.
 */

import { Navigate } from 'react-router-dom'
import { APP_NAME } from '../lib/appConfig.js'
import { useAppSession } from '../lib/AppSessionContext.jsx'
import { useErrorLog } from '../lib/useErrorLog.js'
import { RefreshButton } from '../components/ui.jsx'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import SectionListPage, { useSectionParam } from '../components/SectionListPage.jsx'
import ConfigurationSection from '../components/administration/ConfigurationSection.jsx'
import ErrorLogSection from '../components/administration/ErrorLogSection.jsx'
import IntendedUsageSection from '../components/administration/IntendedUsageSection.jsx'
import { AccountSecuritySection } from '../components/administration/AccountSecuritySection.jsx'
import UserAdminSection from '../components/administration/UserAdminSection.jsx'
import BackupRestoreSection from '../components/administration/BackupRestoreSection.jsx'
import DeveloperOptionsSection from '../components/administration/DeveloperOptionsSection.jsx'

const ERROR_LOG_SECTION = 'errorLog'

export default function Administration() {
  const {
    authEnabled,
    canAdminister,
    currentUser,
    passwordPolicy,
    securityProfile,
    dataProviderIntended,
    developerOptionsEnabled,
    activeLocalProfile,
    setSecurityProfile,
    setPasswordPolicy,
    setDataProviderIntended,
  } = useAppSession()
  // Read here rather than inside the section so its refresh can sit on the section's title, where every
  // refresh control goes. It still reads only while the section is open.
  const requestedSection = useSectionParam()
  const errorLog = useErrorLog(canAdminister && requestedSection === ERROR_LOG_SECTION)

  if (!canAdminister) return <Navigate to="/settings" replace />

  const sections = [
    {
      key: 'backup',
      title: 'Backup / Restore',
      help: <FeatureExplainer topic="data-and-backups" placement="bottom-left" />,
      content: <BackupRestoreSection />,
    },
    {
      key: ERROR_LOG_SECTION,
      title: 'Error log',
      description: 'Errors the server recorded, newest first, for when something did not work and the screen did not say why.',
      refresh: <RefreshButton onRefresh={errorLog.load} loading={errorLog.loading} />,
      content: <ErrorLogSection log={errorLog.log} error={errorLog.error} />,
    },
    // With sign-in protection off there are no accounts to manage, only the local profiles.
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
      key: 'intendedUsage',
      title: 'Intended usage',
      description: `How ${APP_NAME} will be run and whether a bank or data provider will be connected which involves secrets that need protecting.`,
      help: <FeatureExplainer topic="data-and-backups" placement="bottom-left" />,
      content: (
        <IntendedUsageSection
          authEnabled={authEnabled}
          securityProfile={securityProfile}
          dataProviderIntended={dataProviderIntended}
          passwordPolicy={passwordPolicy}
          onProfileChange={value => setSecurityProfile?.(value)}
          onDataProviderChange={value => setDataProviderIntended?.(value)}
        />
      ),
    },
    {
      key: 'configuration',
      title: 'Startup configuration',
      help: <FeatureExplainer topic="configuration" placement="bottom-left" />,
      content: <ConfigurationSection authEnabled={authEnabled} currentUser={currentUser} />,
    },
    developerOptionsEnabled && {
      key: 'developerOptions',
      title: 'Developer options',
      description: 'Useful tools for developers and testing workflows.',
      content: <DeveloperOptionsSection authEnabled={authEnabled} />,
    },
  ]

  return (
    <SectionListPage
      title="Administration"
      help={<FeatureExplainer topic="page-administration" placement="bottom-left" />}
      sections={sections}
    />
  )
}
