# Menu consolidation

Pop-up menus are built at least four ways: `ActionMenu` (the `⋯` menu), the right-click `ContextMenu` in
`TransactionRow.jsx`, a second `ContextMenu` in `pages/Categories.jsx` with its own `itemStyle` and inline
hover handlers, and the bulk, sort and per-suggestion menus in `ImportRuleSuggestionReview.jsx`
(`getMenuButtonStyle`, `getSortMenuItemStyle`). Each draws its own rows, hover state, separators and
viewport placement, so a fix to one (keyboard focus, edge clamping, a destructive item's colour) reaches
none of the others.

The work is to settle one menu shell, opened from a button or from a right-click, with one row
component that covers a plain item, a checked item, a disabled item with its reason, and the
destructive item last and separated (`ui-patterns.md` → *Editing in place*), and to move the four onto
it. `ImportAccountHandlingPicker.jsx` has a menu-like list that may belong to the picker family
instead; decide that while surveying.
