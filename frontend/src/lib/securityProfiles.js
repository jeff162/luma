// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Setup presets describing the deployment shape: standalone (this one machine) vs client-server
// (backend on a networked box, reached from other devices). They steer recommendations — whether
// sign-in is recommended, and the transport (HTTPS) guidance — without encoding enforcement here.
export const SECURITY_PROFILES = [
  {
    value: 'local_private',
    label: 'Standalone',
    summary: 'Luma runs on this one computer and you use it right here. Nothing else connects to it.',
    recommendedAuth: false,
  },
  {
    value: 'network_private',
    label: 'Client-server',
    summary: 'The backend runs on a computer on your network, and you (and anyone you allow) reach it from a browser on another device.',
    recommendedAuth: true,
  },
]

export function getSecurityProfile(profile) {
  return SECURITY_PROFILES.find(option => option.value === profile) || SECURITY_PROFILES[0]
}
