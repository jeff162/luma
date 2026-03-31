import { Badge } from './ui.jsx'

export default function CategoryDisplay({
  id,
  name,
  emptyLabel = 'Uncategorized',
  emptyFontSize = 13,
}) {
  if (name) {
    return <Badge label={name} toneKey={id || name} />
  }

  return <span style={{ color: 'var(--muted)', fontSize: emptyFontSize }}>{emptyLabel}</span>
}
