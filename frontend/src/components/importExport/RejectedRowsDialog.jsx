// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Read-only viewer for rows an import dropped because they had a zero amount or
// failed validation against the chosen column mappings. Renders the saved CSV
// cell values when the batch persisted them, degrades to reason+row-number when
// it did not, and offers a hand-off to the raw file viewer.

import {
  Button,
  FloatingPanel,
  FloatingPanelHeader,
  OverlayBackdrop,
} from '../ui.jsx'

export function RejectedRowsDialog({ rows = [], headers = [], count = 0, title = 'this import', onClose, onOpenRawViewer }) {
  const effectiveCount = Math.max(count, rows.length)
  const tableHeaders = headers.length > 0
    ? headers
    : Array.from(new Set(rows.flatMap(row => Object.keys(row?.values || {}))))
  const hasSavedRowValues = tableHeaders.length > 0
  return (
    <OverlayBackdrop zIndex={1200} tint="rgba(15, 23, 42, 0.42)">
      <FloatingPanel style={{ width: 'min(1200px, 100%)', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <FloatingPanelHeader style={{ padding: '16px 20px 14px' }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
              {effectiveCount} rejected row{effectiveCount === 1 ? '' : 's'} from {title}
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
              These rows were not imported because they either had a zero amount or did not validate against the selected column mappings.
            </div>
          </div>
        </FloatingPanelHeader>
        <div style={{ padding: 18, overflow: 'auto' }}>
          {rows.length > 0 ? (
            <div style={{ minWidth: hasSavedRowValues ? 920 : 420, display: 'grid', gap: 12 }}>
              {!hasSavedRowValues ? (
                <div style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 36%, var(--surface))', fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
                  Detailed CSV cell values were not saved for this import, so only the rejection reason and row number are available here.
                </div>
              ) : null}
              <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={{ position: 'sticky', top: 0, zIndex: 1, textAlign: 'left', padding: '10px 12px', background: 'color-mix(in srgb, var(--surface2) 84%, var(--surface))', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>Reason</th>
                    <th style={{ position: 'sticky', top: 0, zIndex: 1, textAlign: 'left', padding: '10px 12px', background: 'color-mix(in srgb, var(--surface2) 84%, var(--surface))', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>Row</th>
                    {tableHeaders.map(header => (
                      <th key={header} style={{ position: 'sticky', top: 0, zIndex: 1, textAlign: 'left', padding: '10px 12px', background: 'color-mix(in srgb, var(--surface2) 84%, var(--surface))', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={`${row.row}:${index}`}>
                      <td style={{ verticalAlign: 'top', padding: '10px 12px', borderBottom: '1px solid color-mix(in srgb, var(--border) 72%, transparent)', minWidth: 160 }}>
                        <div style={{ display: 'grid', gap: 4 }}>
                          <span style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            width: 'fit-content',
                            padding: '2px 8px',
                            borderRadius: 999,
                            fontSize: 11,
                            fontWeight: 600,
                            border: '1px solid var(--border)',
                            background: row.kind === 'zero_amount' || row.kind === 'currency'
                              ? 'color-mix(in srgb, var(--warning) 12%, var(--surface2))'
                              : 'color-mix(in srgb, var(--danger) 10%, var(--surface2))',
                            color: row.kind === 'zero_amount' || row.kind === 'currency' ? '#b45309' : '#dc2626',
                          }}>
                            {row.kind === 'zero_amount' ? 'Zero amount' : row.kind === 'currency' ? 'Other currency' : 'Validation error'}
                          </span>
                          <span>{row.reason}</span>
                        </div>
                      </td>
                      <td style={{ verticalAlign: 'top', padding: '10px 12px', borderBottom: '1px solid color-mix(in srgb, var(--border) 72%, transparent)', whiteSpace: 'nowrap', color: 'var(--muted)', fontWeight: 600 }}>
                        {row.row}
                      </td>
                      {tableHeaders.map(header => (
                        <td key={header} style={{ verticalAlign: 'top', padding: '10px 12px', borderBottom: '1px solid color-mix(in srgb, var(--border) 72%, transparent)', whiteSpace: 'nowrap' }}>
                          {String(row?.values?.[header] ?? '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 36%, var(--surface))', fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
              Detailed rejected rows are not available for this import summary, but the raw file viewer can still be opened to inspect the file around the affected rows.
            </div>
          )}
        </div>
        <div style={{ padding: '14px 18px', borderTop: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 66%, var(--surface))', display: 'flex', justifyContent: onOpenRawViewer ? 'space-between' : 'flex-end', gap: 10, flexWrap: 'wrap' }}>
          {onOpenRawViewer ? <Button variant="ghost" onClick={onOpenRawViewer}>Open raw file viewer</Button> : null}
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </FloatingPanel>
    </OverlayBackdrop>
  )
}
