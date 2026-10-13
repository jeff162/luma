// @vitest-environment jsdom

// The section states what the server detected: how this browser is connected, and whether other devices
// can open the installation. Nothing is chosen or recommended.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NetworkAccessSection from '../NetworkAccessSection.jsx'

const getAuthStatus = vi.fn()
vi.mock('../../../lib/api.js', () => ({ api: { getAuthStatus: (...args) => getAuthStatus(...args) } }))

function connectedAs(transport) {
  getAuthStatus.mockResolvedValue({ transport })
}

describe('NetworkAccessSection', () => {
  beforeEach(() => getAuthStatus.mockReset())
  afterEach(cleanup)

  it('says a browser on the server is local, whatever the scheme', async () => {
    connectedAs({ is_loopback: true, is_https: false })
    render(<NetworkAccessSection authEnabled={false} />)
    expect(await screen.findByText(/is on the computer/)).toBeTruthy()
    expect(screen.queryByText(/Passkeys are unavailable/)).toBeNull()
  })

  it('states what plain HTTP over the network costs', async () => {
    connectedAs({ is_loopback: false, is_https: false })
    render(<NetworkAccessSection authEnabled />)
    expect(await screen.findByText(/over the network, without HTTPS/)).toBeTruthy()
    expect(screen.getByText(/Passkeys are unavailable/)).toBeTruthy()
    expect(screen.getByText(/Data sources cannot be connected in this session/)).toBeTruthy()
  })

  it('describes what sign-in protection keeps out by who can reach the installation', async () => {
    connectedAs({ is_loopback: true, is_https: false, reachable_from_network: false })
    const { unmount } = render(<NetworkAccessSection authEnabled={false} />)
    expect(await screen.findByText(/Only this computer can open/)).toBeTruthy()
    expect(screen.getByText(/keeps other people who use this computer out/)).toBeTruthy()
    expect(screen.getByText('Sign-in protection is off.')).toBeTruthy()
    unmount()

    // The same browser on the server, once the server is open to the network.
    connectedAs({ is_loopback: true, is_https: false, reachable_from_network: true })
    render(<NetworkAccessSection authEnabled />)
    expect(await screen.findByText(/Other devices on the network can open/)).toBeTruthy()
    expect(screen.getByText('Sign-in protection is on.')).toBeTruthy()
  })

  it('takes a browser on another device as proof the network gets through', async () => {
    connectedAs({ is_loopback: false, is_https: true, reachable_from_network: false })
    render(<NetworkAccessSection authEnabled />)
    expect(await screen.findByText(/Other devices on the network can open/)).toBeTruthy()
  })
})
