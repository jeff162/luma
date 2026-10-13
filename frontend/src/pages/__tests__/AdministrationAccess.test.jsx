// @vitest-environment jsdom

// Who the Administration page is for, and the one thing its layout promises: a section named in the URL
// is the section on screen. The server refuses a member's requests either way; what is pinned here is
// that a member is not shown a page of controls that would all be refused.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { AppSessionProvider } from '../../lib/AppSessionContext.jsx'

const section = name => ({ default: () => <div>{`${name} body`}</div> })
vi.mock('../../components/administration/ConfigurationSection.jsx', () => section('configuration'))
vi.mock('../../components/administration/BackupRestoreSection.jsx', () => section('backup'))
vi.mock('../../components/administration/ErrorLogSection.jsx', () => section('error log'))
vi.mock('../../components/administration/NetworkAccessSection.jsx', () => section('network access'))
vi.mock('../../components/administration/UserAdminSection.jsx', () => section('user management'))
vi.mock('../../components/administration/DeveloperOptionsSection.jsx', () => section('developer options'))
vi.mock('../../components/administration/AccountSecuritySection.jsx', () => ({
  AccountSecuritySection: () => <div>sign-in protection body</div>,
}))
vi.mock('../../help/FeatureExplainer.jsx', () => ({ default: () => null }))
vi.mock('../../lib/useErrorLog.js', () => ({ useErrorLog: () => ({ log: null, error: '', loading: false, load: () => {} }) }))

const { default: Administration } = await import('../Administration.jsx')

afterEach(cleanup)

function mountAt(path, session) {
  return render(
    <AppSessionProvider value={session}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/administration" element={<Administration />} />
          <Route path="/settings" element={<div>settings page</div>} />
        </Routes>
      </MemoryRouter>
    </AppSessionProvider>,
  )
}

describe('the Administration page', () => {
  it('sends a member to Settings', () => {
    mountAt('/administration?section=userManagement', { authEnabled: true, canAdminister: false })
    expect(screen.getByText('settings page')).toBeTruthy()
    expect(screen.queryByText('user management body')).toBeNull()
  })

  it('opens the section the URL names, and only that one', () => {
    mountAt('/administration?section=userManagement', { authEnabled: true, canAdminister: true })
    expect(screen.getByText('user management body')).toBeTruthy()
    expect(screen.queryByText('backup body')).toBeNull()
    expect(screen.getByRole('button', { name: 'User management' }).getAttribute('aria-current')).toBe('page')
  })

  it('falls back to the first section for one this install does not list', () => {
    // User management exists only while sign-in protection is on.
    mountAt('/administration?section=userManagement', { authEnabled: false, canAdminister: true })
    expect(screen.getByText('backup body')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'User management' })).toBeNull()
  })
})
