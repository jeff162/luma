// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The navigation pane's icons, drawn here rather than taken from an icon library: the pane needs about
// sixteen, and a dependency for that many is more than they are worth. Each is a 24-unit outline stroked
// in `currentColor`, so it takes the colour of the row it sits in — muted, active or toned — in either
// theme.
//
// On a tablet there is no hover to name them, so each has to be recognizable on its own. That is why the
// page icons carry soft colour fills: grey outlines alone all weigh the same, and a tint gives each one
// a shape the eye finds. Where a colour can mean something it does — green for money, the chart palette
// for the Dashboard and for the categories a rule sorts into, the ledger's own purple for Recurring. The
// warning amber is left out, because in the pane it marks what needs attention.

import { CHART_PALETTE } from '../lib/chartPalette.js'

const PATHS = {
  // Teal rather than the chart's third colour, orange, so no slice repeats a warning, and not green,
  // which is the coin's beneath it.
  dashboard: (
    <>
      <path d="M12 12V3a9 9 0 1 1-3.08 17.46z" fill={CHART_PALETTE[0]} fillOpacity="0.55" />
      <path d="M12 12 8.92 20.46A9 9 0 0 1 3.54 8.92z" fill={CHART_PALETTE[1]} fillOpacity="0.55" />
      <path d="M12 12 3.54 8.92A9 9 0 0 1 12 3z" fill={CHART_PALETTE[5]} fillOpacity="0.55" />
    </>
  ),
  transactions: (
    <>
      <circle cx="12" cy="12" r="9" fill="var(--success)" fillOpacity="0.18" />
      <path
        d="M15 9c-.5-1-1.6-1.6-3-1.6-1.7 0-2.9.9-2.9 2.2 0 3 6 1.7 6 4.8 0 1.3-1.3 2.2-3.1 2.2-1.5 0-2.6-.6-3.1-1.6M12 5.5v13"
        stroke="var(--success)"
      />
    </>
  ),
  import: (
    <>
      <path d="M4 15v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3z" fill="var(--success)" fillOpacity="0.28" stroke="none" />
      <path d="M12 3v12M7.5 10.5 12 15l4.5-4.5" />
      <path d="M4 15v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3" />
    </>
  ),
  // One transaction card routed to one of several categories, which is what a rule does.
  rules: (
    <>
      <rect x="1.5" y="9.5" width="6" height="5" rx="1.5" />
      <path d="M7.5 12h3.5M11 4v16M11 4h3M11 12h3M11 20h3" />
      <rect x="15" y="2" width="7.5" height="4" rx="1.25" fill={CHART_PALETTE[0]} fillOpacity="0.55" />
      <rect x="15" y="10" width="7.5" height="4" rx="1.25" fill={CHART_PALETTE[1]} fillOpacity="0.55" />
      <rect x="15" y="18" width="7.5" height="4" rx="1.25" fill={CHART_PALETTE[5]} fillOpacity="0.55" />
    </>
  ),
  // Manila, the colour of a paper folder, muted enough not to read as the warning amber.
  categories: (
    <>
      <path d="M7 11a2 2 0 0 1 2-2h3l1.5 2H19a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z" fill="#d4a85a" fillOpacity="0.45" />
      <path d="M3 15V6a2 2 0 0 1 2-2h3l1.5 2H15a2 2 0 0 1 2 2v1" />
    </>
  ),
  // The ledger's ↻ recurring marker, so the page and the rows it describes share a sign.
  recurring: <path d="M20 12a8 8 0 1 1-2.35-5.65L20 8.5M20 3.5v5h-5" stroke="var(--accent2)" />,
  // Slate, because a warm tint would make an empty task list look like work waiting; the badge is the
  // only colour on this icon that says there is something to do.
  tasks: (
    <>
      <circle cx="12" cy="12" r="9" fill="#64748b" fillOpacity="0.3" />
      <path d="m8 12.5 2.8 2.8L16.5 9" />
    </>
  ),
  // The middle columns give way to a $, which says the building is a bank rather than a courthouse.
  accounts: (
    <>
      <rect x="5" y="8" width="14" height="13" fill="var(--success)" fillOpacity="0.28" stroke="none" />
      <path d="M12 3 3 8h18zM5 11v7M19 11v7M3 21h18" />
      <path d="M14.3 12.1c-.4-.7-1.2-1.1-2.3-1.1-1.3 0-2.2.7-2.2 1.6 0 2.2 4.6 1.3 4.6 3.6 0 1-1 1.6-2.4 1.6-1.1 0-2-.4-2.4-1.1M12 9.8v8.9" />
    </>
  ),
  // Silver: the gear's face filled, its hole cut out (evenodd) so the row behind shows through in any
  // state.
  settings: (
    <path
      d="M10.57 4.94 10.77 2.58H13.23L13.43 4.94 15.98 6 17.79 4.47 19.53 6.21 18 8.02 19.06 10.57 21.42 10.77V13.23L19.06 13.43 18 15.98 19.53 17.79 17.79 19.53 15.98 18 13.43 19.06 13.23 21.42H10.77L10.57 19.06 8.02 18 6.21 19.53 4.47 17.79 6 15.98 4.94 13.43 2.58 13.23V10.77L4.94 10.57 6 8.02 4.47 6.21 6.21 4.47 8.02 6zM15 12a3 3 0 1 0-6 0 3 3 0 1 0 6 0z"
      fill="var(--text)"
      fillOpacity="0.28"
      fillRule="evenodd"
    />
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" fill={CHART_PALETTE[6]} fillOpacity="0.3" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.33c-.55.22-.9.75-.9 1.34V14" />
      <path d="M12 17.25h.01" />
    </>
  ),
  sync: <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 3.5V8h4.5M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20.5V16h-4.5" />,
  syncDone: <path d="m5 12.5 4.5 4.5L19 7" />,
  duplicates: (
    <>
      <rect x="8" y="8" width="13" height="13" rx="2" />
      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
    </>
  ),
  reconciliation: (
    <>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <rect x="9" y="2" width="6" height="4" rx="1" />
      <path d="m9 13.5 2 2 4-4.5" />
    </>
  ),
  importDetail: <path d="M12 3 4 7.5v9L12 21l8-4.5v-9zM4 7.5 12 12l8-4.5M12 12v9M8 5.25l8 4.5" />,
  // A folder being added to, so it differs from the Categories page's stacked folders.
  groupCategories: (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 11v6M9 14h6" />
    </>
  ),
  profile: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  signOut: <path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3M16 17l5-5-5-5M21 12H9" />,
  shutDown: <path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0" />,
  collapse: <path d="M11 17l-5-5 5-5M18 17l-5-5 5-5" />,
  expand: <path d="M6 17l5-5-5-5M13 17l5-5-5-5" />,
}

export function NavIcon({ name, size = 18, className }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flexShrink: 0 }}
    >
      {PATHS[name]}
    </svg>
  )
}
