// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Settings: everything a member may change. What only an administrator may do is on Administration
 * (`pages/Administration.jsx`), and the two are not mixed on one page — About's update check is the
 * one item that straddles the line, and hides its admin half in place.
 */

import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { useAppSession } from '../lib/AppSessionContext.jsx'
import { formatBytes, formatShare } from '../lib/storageFormat.js'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import SectionListPage, { Subsection } from '../components/SectionListPage.jsx'
import ThemeSection from '../components/settings/ThemeSection.jsx'
import CurrencySection from '../components/settings/CurrencySection.jsx'
import SignInFactorsSection from '../components/settings/SignInFactorsSection.jsx'
import ImportStorageSection from '../components/settings/ImportStorageSection.jsx'
import { DismissedDuplicatePairsSection, DistinctAccountPairsSection } from '../components/settings/DuplicateExceptionSections.jsx'
import { RulesTrashSection, TransactionsTrashSection, DuplicateTransactionsTrashSection } from '../components/settings/TrashSections.jsx'
import AboutSection from '../components/settings/AboutSection.jsx'

export default function Settings() {
  const {
    authEnabled,
    canAdminister,
    passwordPolicy,
    dbInstanceId,
    bundledLicenseAvailable,
    buildStamp,
    thirdPartyNoticesScope,
  } = useAppSession()

  // What the two housekeeping sections hold, read once here so the list can say it before either is
  // opened, and again whenever one of them changes it. A failed read leaves the names without figures.
  const [storage, setStorage] = useState(null)
  const loadStorage = useCallback(() => {
    api.getStorageSummary().then(setStorage).catch(() => { })
  }, [])
  useEffect(() => { loadStorage() }, [loadStorage])
  const trash = storage?.trash
  const trashTotal = trash ? trash.transactions + trash.duplicates + trash.rules : 0
  const detailBytes = storage?.import_detail?.bytes || 0
  const detailShare = formatShare(detailBytes, storage?.database_bytes).replace('about ', '')
  const counted = (title, count) => (trash ? `${title} (${count.toLocaleString()})` : title)

  const sections = [
    {
      key: 'appearance',
      title: 'Appearance',
      description: 'Select the color theme.',
      content: <ThemeSection />,
    },
    {
      key: 'currency',
      title: 'Currency',
      description: 'Define the currency used by the ledger.',
      help: <FeatureExplainer topic="single-currency" placement="bottom-left" />,
      content: <CurrencySection />,
    },
    // With sign-in protection off there is no sign-in for a passkey or a second factor to belong to.
    authEnabled && {
      key: 'signInMethods',
      title: 'Sign-in methods',
      description: 'The password, passkeys and two-factor sign-in for this account.',
      help: <FeatureExplainer topic="account-security" placement="bottom-left" />,
      content: <SignInFactorsSection passwordPolicy={passwordPolicy} />,
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
      key: 'importStorage',
      title: 'Import storage',
      note: detailBytes ? [formatBytes(detailBytes), detailShare].filter(Boolean).join(' · ') : '',
      description: 'The record each import keeps of the rows it refused, and the space it uses.',
      content: <ImportStorageSection storage={storage} onChanged={loadStorage} />,
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
        </div>
      ),
    },
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
      sections={sections}
    />
  )
}
