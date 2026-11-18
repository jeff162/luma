// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The navigation pane's statement of which database this copy is open on.
//
// It sits with the version badge under the logo because it answers the same question that does — which
// copy am I looking at — and the two are read together: a checkout pointed at a restored backup and one
// pointed at real data are otherwise indistinguishable from anywhere in the app.
//
// Admin-or-local only, and enforced by the *server*: the path rides `/auth/status` solely for a session
// that could already read it from the configuration report, so this component renders nothing for
// everyone else without holding a second copy of that rule.

import { useFlash } from '../lib/useFlash.js'
import { Tooltip } from './ui.jsx'
import { useShownDataLocation } from '../lib/dataLocation.js'

const COPIED_MESSAGE_MS = 1400

// Left-to-right mark. Written as an escape rather than pasted in: it renders as nothing, and a literal
// invisible character is one a later edit deletes without seeing it.
const LTR_MARK = '\u200E'

export default function DataLocationLine({ dataLocation }) {
  const [copied, flashCopied] = useFlash(COPIED_MESSAGE_MS)

  const described = useShownDataLocation(dataLocation)
  if (!described) return null

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(described.path)
      flashCopied('Copied')
    } catch {
      // A blocked clipboard is a normal outcome (an insecure origin, a browser policy), and silence
      // here reads as a dead control — the path is on screen to select by hand either way.
      flashCopied('Could not copy')
    }
  }

  return (
    <Tooltip
      align="left"
      maxWidth={420}
      // Without this the wrapper is `inline-flex` and shrink-wraps the path, so the button's `width:
      // 100%` measures against a box already as wide as its text and nothing ever elides — the pane's
      // own `overflow: hidden` then cuts the path off mid-character instead. `Tooltip` exposes
      // `triggerStyle` for exactly this case.
      triggerStyle={{ display: 'block', minWidth: 0 }}
      content={(
        <div style={{ display: 'grid', gap: 4 }}>
          <div style={{ wordBreak: 'break-all' }}>{described.path}</div>
          {described.controlPath ? (
            <div style={{ color: 'var(--muted)', wordBreak: 'break-all' }}>
              Control database: {described.controlPath}
            </div>
          ) : null}
          <div style={{ color: 'var(--muted)' }}>{copied || 'Click to copy'}</div>
        </div>
      )}
    >
      <button
        type="button"
        onClick={copyPath}
        aria-label={`Data location: ${described.path}. Copy.`}
        style={{
          background: 'none', border: 'none', padding: 0, marginTop: 2,
          color: 'var(--muted)', cursor: 'pointer',
          display: 'block', width: '100%', minWidth: 0, overflow: 'hidden',
          fontFamily: 'inherit', fontSize: 11, lineHeight: 1.4,
        }}
      >
        {/* The elision lives on this span rather than on the button, because a button's contents sit in
            an anonymous box that sizes to them — `text-overflow` on the button itself is unreliable. It
            runs at the *start* so the tail survives: the leaf directory and the file name are what
            differ between two installations, while the head is the same home prefix on every copy.
            Done in CSS rather than by trimming the string, since the pane is user-resizable and a
            character count would be right at exactly one width.

            `direction: rtl` is what moves the ellipsis to the overflowing end. The path is still
            left-to-right text, and its leading `~/` is neutral enough to be reordered to the far end by
            that switch, so the value is prefixed with a left-to-right mark to anchor it. */}
        <span
          data-testid="data-location-path"
          style={{
            display: 'block',
            direction: 'rtl',
            textAlign: 'left',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {`${LTR_MARK}${dataLocation.db_display_path || described.path}`}
        </span>
      </button>
    </Tooltip>
  )
}
