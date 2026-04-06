// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

export const SECURITY_PROFILES = [
  {
    value: 'local_private',
    label: 'Private localhost only',
    summary: 'Browser and backend run on the same machine, with no need for access outside localhost.',
    recommendedAuth: false,
    suggestedPasswordPolicy: 'none',
  },
  {
    value: 'network_private',
    label: 'Private network or remote access',
    summary: 'Frontend and backend are on different systems, or the app may be reachable over your local network.',
    recommendedAuth: true,
    suggestedPasswordPolicy: 'min_8',
  },
  {
    value: 'household_shared',
    label: 'Shared household access',
    summary: 'More than one person may use the app, but this is still a household-scale installation rather than a hosted service.',
    recommendedAuth: true,
    suggestedPasswordPolicy: 'strong',
  },
  {
    value: 'multi_tenant',
    label: 'Multi-tenant preview',
    summary: 'Work-in-progress path for true multi-tenant hosting. Treat strong sign-in requirements as the baseline here.',
    recommendedAuth: true,
    suggestedPasswordPolicy: 'strong',
  },
]

export function getSecurityProfile(profile) {
  return SECURITY_PROFILES.find(option => option.value === profile) || SECURITY_PROFILES[0]
}
