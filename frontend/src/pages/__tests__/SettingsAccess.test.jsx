// @vitest-environment jsdom

// Who each Settings section is for, and the one thing its layout promises: a section named in the URL
// is the section on screen. The server refuses a member's requests either way; what is pinned here is
// that a member is not listed controls that would all be refused.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { AppSessionProvider } from '../../lib/AppSessionContext.jsx'

const section = name => ({ default: () => <div>{`${name} body`}</div> })
vi.mock('../../components/administration/ConfigurationSection.jsx', () => section('configuration'))
vi.mock('../../components/administration/BackupRestoreSection.jsx', () => section('backup'))
vi.mock('../../components/administration/ErrorLogSection.jsx', () => section('error log'))
vi.mock('../../components/administration/SecurityChecklistSection.jsx', () => section('security checklist'))
vi.mock('../../components/administration/UserAdminSection.jsx', () => section('user management'))
vi.mock('../../components/administration/DeveloperOptionsSection.jsx', () => section('developer options'))
vi.mock('../../components/administration/AccountSecuritySection.jsx', () => ({
  AccountSecuritySection: () => <div>sign-in protection body</div>,
}))
vi.mock('../../components/ServerCertificate.jsx', () => ({ ServerCertificateSection: () => null }))
vi.mock('../../components/settings/ThemeSection.jsx', () => section('appearance'))
vi.mock('../../components/settings/CurrencySection.jsx', () => section('currency'))
vi.mock('../../components/settings/SignInFactorsSection.jsx', () => section('security'))
vi.mock('../../components/settings/ImportStorageSection.jsx', () => section('import storage'))
vi.mock('../../components/settings/AboutSection.jsx', () => section('about'))
vi.mock('../../components/settings/DuplicateExceptionSections.jsx', () => ({
  DismissedDuplicatePairsSection: () => null,
  DistinctAccountPairsSection: () => null,
}))
vi.mock('../../components/settings/TrashSections.jsx', () => ({
  TransactionsTrashSection: () => null,
  DuplicateTransactionsTrashSection: () => null,
  RulesTrashSection: () => null,
  BackupHistoryTrashSection: () => null,
}))
vi.mock('../../help/FeatureExplainer.jsx', () => ({ default: () => null }))
vi.mock('../../lib/useErrorLog.js', () => ({ useErrorLog: () => ({ log: null, error: '', loading: false, load: () => {} }) }))
vi.mock('../../lib/serverCertificate.js', () => ({ useServerCertificate: () => [null, () => {}] }))
vi.mock('../../lib/api.js', () => ({ api: { getStorageSummary: () => new Promise(() => {}) } }))

const { default: Settings } = await import('../Settings.jsx')

afterEach(cleanup)

function mountAt(path, session) {
  return render(
    <AppSessionProvider value={session}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </MemoryRouter>
    </AppSessionProvider>,
  )
}

describe('the Settings page', () => {
  it('lists a member only what a member may change', () => {
    mountAt('/settings?section=userManagement', { authEnabled: true, canAdminister: false })
    expect(screen.getByRole('button', { name: 'Security' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Currency' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Backup / Restore' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Server' })).toBeNull()
    // The section the URL names is not theirs, so the first one they are listed opens instead.
    expect(screen.queryByText('user management body')).toBeNull()
    expect(screen.getByText('appearance body')).toBeTruthy()
  })

  it('opens the section the URL names, and only that one', () => {
    mountAt('/settings?section=userManagement', { authEnabled: true, canAdminister: true })
    expect(screen.getByText('user management body')).toBeTruthy()
    expect(screen.queryByText('backup body')).toBeNull()
    expect(screen.getByRole('button', { name: 'User management' }).getAttribute('aria-current')).toBe('page')
  })

  it('falls back to the first section for one this install does not list', () => {
    // User management exists only while sign-in protection is on.
    mountAt('/settings?section=userManagement', { authEnabled: false, canAdminister: true })
    expect(screen.getByText('appearance body')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'User management' })).toBeNull()
  })
})
