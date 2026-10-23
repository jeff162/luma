// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ResponsiveContainer, Sankey, Tooltip } from 'recharts'
import {
  CASH_FLOW_HUB_ID,
  INFLOW,
  OUTFLOW,
  cashFlowLabelLayout,
  nodeFromTooltipPayload,
} from '../lib/cashFlowGraph.js'
import {
  CHART_TOOLTIP_CONTENT_STYLE,
  CHART_TOOLTIP_LABEL_STYLE,
  formatMoneyMagnitude,
  formatSignedMoneyAmount,
} from '../lib/moneyDisplay.js'
import { EmptyState } from './ui.jsx'

/*
 * The single-period cash-flow diagram: what came in on the left, what went out on the right, joined
 * through one hub. The graph itself — which side each bucket lands on, the long-tail collapsing, the
 * balancing terminal — is decided in `lib/cashFlowGraph.js`; this file is the drawing and the
 * interaction.
 *
 * Recharts ships `<Sankey>` but its stock node and link are bare rectangles and paths with no labels,
 * so both are rendered here. Two rules from the frame's design shape what they draw:
 *
 * - **The side tells the direction.** A link's width is the magnitude, because no link can be drawn
 *   with a negative width, and the amount beside each node is the same magnitude: left is money in and
 *   right is money out, so the column already says which way the money went. The hub, on neither side,
 *   shows the signed net.
 * - **Every node bottoms out in transactions.** A node that cannot be opened is a defect in this
 *   diagram, not a documented limitation — so the buckets drill to their transactions, the collapsed
 *   `Other` node pages one level further into its own tail, and the balancing terminal, which stands for
 *   an arithmetic remainder rather than any transaction, is the one node drawn as inert and says so.
 *
 * Layout is fixed at three columns — sources, hub, destinations — and each node's column is read off the
 * node itself rather than off the depth recharts derived, so labels sit outside the diagram on their own
 * side and stay clear of the links. How much of a label fits is decided per node by
 * `cashFlowLabelLayout`: node height is proportional to value, so a long tail puts several near-zero
 * nodes in a row and a fixed two-line stack would overlap every one of them.
 */

const NODE_WIDTH = 14
const NODE_PADDING = 14
const ROW_HEIGHT = 30
const MIN_HEIGHT = 300
// Room outside the columns for the labels. A long category name is truncated rather than allowed to
// widen this, since the diagram between them is what the eye is meant to follow.
const LABEL_MARGIN = 170

// The balancing terminal is the only node standing for no transactions, so it is also the only one that
// does not open.
function isOpenable(node) {
  return !!node && !node.isBalance && !node.isHub
}

function amountText(node) {
  return node.isHub ? formatSignedMoneyAmount(node.cashValue) : formatMoneyMagnitude(node.total)
}

function CashFlowNode({ x, y, width, height, payload, onNodeClick }) {
  const node = payload || {}
  const openable = isOpenable(node)
  // Read the column off the node's own identity rather than off the Sankey depth recharts computed:
  // a period with nothing on one side would shift those depths, and a mislabelled hub is the kind of
  // defect that only shows up on the one period that produces it.
  const isHub = node.key === CASH_FLOW_HUB_ID
  const isSource = node.side === INFLOW
  const labelX = isSource ? x - 8 : x + width + 8
  const anchor = isSource ? 'end' : 'start'
  const midY = y + height / 2
  const label = cashFlowLabelLayout({
    height,
    padding: NODE_PADDING,
    name: node.name,
    amount: amountText(node),
  })

  return (
    <g
      style={{ cursor: openable ? 'pointer' : 'default' }}
      onClick={openable ? () => onNodeClick(node) : undefined}
    >
      <rect x={x} y={y} width={width} height={Math.max(height, 1)} fill={node.color} rx={2} />
      <title>{`${node.name} · ${amountText(node)}`}</title>
      {isHub ? (
        // The hub spans nearly the full height, so its label goes above the column rather than beside it.
        <text x={x + width / 2} y={Math.max(y - 8, 12)} textAnchor="middle"
          fontSize={12} fontWeight={600} fill="var(--text)">
          {node.name}
        </text>
      ) : label.lines === 2 ? (
        <>
          <text x={labelX} y={midY - 2} textAnchor={anchor} fontSize={12} fill="var(--text)">
            {label.name}
          </text>
          <text x={labelX} y={midY + 13} textAnchor={anchor} fontSize={11} fill="var(--muted)">
            {label.amount}
          </text>
        </>
      ) : (
        // One text element rather than two, so the pair cannot be split across the node's midline; the
        // amount keeps the muted weight it has in the stacked form. The separator carries a non-breaking
        // space because SVG collapses ordinary runs of whitespace.
        <text x={labelX} y={midY + 4} textAnchor={anchor} fontSize={12} fill="var(--text)">
          {label.name}
          <tspan fill="var(--muted)">{`\u00a0· ${label.amount}`}</tspan>
        </text>
      )}
    </g>
  )
}

function CashFlowLink({ sourceX, sourceY, sourceControlX, targetX, targetY, targetControlX, linkWidth, payload }) {
  // Colour each link by its bucket end rather than by the hub, so a link reads as belonging to the
  // named node it runs to or from.
  const bucket = payload?.source?.isHub ? payload?.target : payload?.source
  return (
    <path
      d={`M${sourceX},${sourceY}C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
      fill="none"
      stroke={bucket?.color || 'var(--border)'}
      strokeOpacity={0.28}
      strokeWidth={Math.max(linkWidth, 1)}
    />
  )
}

function CashFlowTooltip({ payload }) {
  const node = nodeFromTooltipPayload(payload)
  if (!node?.name) return null
  return (
    <div style={CHART_TOOLTIP_CONTENT_STYLE}>
      <div style={CHART_TOOLTIP_LABEL_STYLE}>{node.name}</div>
      <div style={{ color: 'var(--text)', fontSize: 13, fontWeight: 600 }}>
        {amountText(node)}
      </div>
      {node.isOther && (
        <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 2 }}>Click to see what is in here</div>
      )}
    </div>
  )
}

export default function CashFlowSankey({ graph, depths = {}, onNodeClick, onBack }) {
  if (!graph || graph.isEmpty) {
    return <EmptyState message="Nothing moved in or out in this period, once transfers are excluded." />
  }

  const height = Math.max(MIN_HEIGHT, graph.nodes.length * ROW_HEIGHT)
  const backLinks = [
    { side: INFLOW, label: 'Back to the largest sources' },
    { side: OUTFLOW, label: 'Back to the largest destinations' },
  ].filter(entry => (depths[entry.side] || 0) > 0)

  return (
    <>
      <ResponsiveContainer width="100%" height={height}>
        <Sankey
          data={{ nodes: graph.nodes, links: graph.links }}
          nodeWidth={NODE_WIDTH}
          nodePadding={NODE_PADDING}
          margin={{ top: 24, right: LABEL_MARGIN, bottom: 8, left: LABEL_MARGIN }}
          link={props => <CashFlowLink {...props} />}
          node={props => <CashFlowNode {...props} onNodeClick={onNodeClick} />}
          // Keep each column in the order the graph gives (result, buckets largest first, Other). Recharts'
          // layout passes still run, which is what centres the hub, but by default it re-sorts each column
          // by where those passes left the nodes — so Other could land anywhere.
          sort={false}
        >
          {/* Not animated: recharts slides its tooltip between positions, and this one starts in the top-left
              corner, so every first hover watched a label glide across the diagram to the pointer. */}
          <Tooltip content={<CashFlowTooltip />} isAnimationActive={false} />
        </Sankey>
      </ResponsiveContainer>
      <div style={{
        display: 'flex', justifyContent: 'center', gap: 16, alignItems: 'center',
        fontSize: 11, color: 'var(--muted)', marginTop: 4,
      }}>
        {backLinks.map(entry => (
          <button key={entry.side} type="button" onClick={() => onBack(entry.side)} style={{
            background: 'none', border: 'none', padding: '2px 4px',
            color: 'var(--accent2)', cursor: 'pointer', fontSize: 12,
          }}>
            ‹ {entry.label}
          </button>
        ))}
        <span>Click a node to see its transactions</span>
      </div>
    </>
  )
}
