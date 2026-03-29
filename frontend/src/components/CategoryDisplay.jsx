import { Badge } from './ui.jsx'

export default function CategoryDisplay({
  name,
  color,
  icon,
  emptyLabel = 'Uncategorized',
  emptyFontSize = 13,
}) {
  if (name) {
    return <Badge label={name} color={color} icon={icon} />
  }

  return <span style={{ color: 'var(--muted)', fontSize: emptyFontSize }}>{emptyLabel}</span>
}
