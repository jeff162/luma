// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

export default function ImportMappingFieldGrid({ title = 'Column mapping', children, marginBottom = 14 }) {
  return (
    <>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>{title}</div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '24px 30px',
          marginBottom,
        }}
      >
        {children}
      </div>
    </>
  )
}
