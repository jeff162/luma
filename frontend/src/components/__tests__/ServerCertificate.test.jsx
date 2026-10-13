// @vitest-environment jsdom

// The certificate hand-out's gates: it exists only where the server has a certificate to offer, it
// loads under StrictMode as the app runs it, and accepting a changed certificate is offered only to
// whoever may.

import { StrictMode } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { api } from '../../lib/api.js'
import { ServerCertificateLink, ServerCertificatePanel } from '../ServerCertificate.jsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const CERTIFICATE = {
  available: true, fingerprint: 'AB:CD:EF:01', fingerprint_sha1: '12:34:AB',
  name: 'Example Local Authority', expires: '2036-01-01', changed: false,
}

describe('the server certificate hand-out', () => {
  it('offers nothing where the server has no certificate', async () => {
    const read = vi.spyOn(api, 'getProxyCertificate').mockResolvedValue({ available: false })
    render(<StrictMode><ServerCertificateLink /></StrictMode>)
    await vi.waitFor(() => expect(read).toHaveBeenCalled())
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('opens the certificate and its fingerprint from the sign-in screen', async () => {
    vi.spyOn(api, 'getProxyCertificate').mockResolvedValue(CERTIFICATE)
    render(<StrictMode><ServerCertificateLink /></StrictMode>)
    await userEvent.setup().click(await screen.findByRole('button', { name: /certificate/i }))
    expect(screen.getByTestId('certificate-fingerprint').textContent).toBe('AB:CD:EF:01')
  })

  it('states a changed certificate to everyone and lets only an administrator accept it', async () => {
    const changed = { ...CERTIFICATE, changed: true }
    render(<ServerCertificatePanel certificate={changed} />)
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /accept/i })).toBeNull()
    cleanup()

    const onAccept = vi.fn().mockResolvedValue()
    render(<ServerCertificatePanel certificate={changed} onAccept={onAccept} />)
    await userEvent.setup().click(screen.getByRole('button', { name: /accept/i }))
    expect(onAccept).toHaveBeenCalled()
  })

  it('checks a fingerprint read off another device, however that device writes it', async () => {
    render(<ServerCertificatePanel certificate={CERTIFICATE} checkable />)
    const box = screen.getByLabelText('Fingerprint shown on the other computer')
    const user = userEvent.setup()

    // Lower case and unseparated, as the Windows viewer shows its thumbprint.
    await user.type(box, '1234ab')
    expect(screen.getByRole('status')).toBeTruthy()

    await user.clear(box)
    await user.type(box, '1234ac')
    expect(screen.getByRole('alert')).toBeTruthy()

    // Not yet a whole fingerprint of either kind: no verdict, in either direction.
    await user.clear(box)
    await user.type(box, '1234')
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('offers no check where the page itself cannot be believed', () => {
    render(<ServerCertificatePanel certificate={CERTIFICATE} />)
    expect(screen.queryByLabelText('Fingerprint shown on the other computer')).toBeNull()
  })
})
