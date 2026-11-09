// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createPortal } from 'react-dom'
import { useDetailPanelChrome, useRestorablePanelGeometry, DetailPanelShell } from './detailShared.jsx'

/*
 * A dialog the user works in while looking at the page: it floats without a backdrop, moves by its
 * header, resizes from any edge, and reopens where it was left (`panelKey`, a per-user preference). The
 * page behind stays live. `AppDialog` remains the dialog for a question that is answered and closed.
 *
 * It takes `AppDialog`'s props, so moving a dialog across is a change of component plus a `panelKey`:
 *   title, description, help, refresh  the header, laid out as AppDialog lays it out
 *   actions, footerAlign               the buttons, pinned under the body
 *   bodyPadding, bodyStyle             the body, a grid with AppDialog's gap
 *   width                              the opening width in px; `height` (px) opens at a fixed height,
 *                                      and without it the dialog fits its content until resized
 *   header                             a whole custom header, in place of title and description
 * `stackIndex` offsets a first opening (one with no remembered place), for a dialog opened over another
 * floating panel whose header it should leave in view.
 *
 * It portals itself to the page body, so it takes its place in the app's panel stack wherever it is
 * opened from: inside a row, a panel or another dialog, it would otherwise stack within that layer.
 *
 * Escape closes it while it is the topmost panel and focus is not in a text field (DetailPanelShell).
 * Without `onClose` it has no close button and Escape leaves it open, for a dialog whose only way out
 * is one of its own actions.
 */
export default function FloatingDialog({
  panelKey,
  title,
  description,
  help = null,
  refresh = null,
  header = null,
  children,
  actions = null,
  footerAlign = 'end',
  onClose,
  width = 560,
  height = null,
  bodyPadding = 20,
  bodyStyle,
  stackIndex = 0,
}) {
  const geometry = useRestorablePanelGeometry(panelKey, { fallbackWidth: width, fallbackHeight: height })
  const chrome = useDetailPanelChrome(onClose, {
    forceFloating: true, stackIndex: geometry.initialPosition ? 0 : stackIndex, ...geometry,
  })

  const headerContent = header ?? ((title || description) ? (
    <div>
      {title ? (
        <div style={{ fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Kept out of the drag: a press on either must not also pick the dialog up. */}
          {help ? <span onPointerDown={event => event.stopPropagation()} style={{ display: 'inline-flex', fontWeight: 400 }}>{help}</span> : null}
          {title}
          {refresh ? <span onPointerDown={event => event.stopPropagation()} style={{ display: 'inline-flex' }}>{refresh}</span> : null}
        </div>
      ) : null}
      {description ? (
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>{description}</div>
      ) : null}
    </div>
  ) : null)

  return createPortal(
    <DetailPanelShell
      {...chrome}
      onClose={onClose}
      header={headerContent}
      bodyPadding={0}
      footer={actions}
      footerAlign={footerAlign}
    >
      <div style={{ padding: bodyPadding, display: 'grid', gap: 12, alignContent: 'start', ...bodyStyle }}>
        {children}
      </div>
    </DetailPanelShell>,
    document.body,
  )
}
