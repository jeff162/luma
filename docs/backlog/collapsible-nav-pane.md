# Collapsible navigation pane

**Design settled, not started (2026-10-24).** Let the navigation pane collapse to a column of icons and
open again, so a tablet screen gives its width to the page. The tablet is the reason for it, and that
shapes several of the choices below.

## Decided

- **It opens and closes like a sideways window shade**: the pane's width animates between full and the
  icon column, and the page beside it follows rather than jumping.
- **One control does it**, a toggle button: a chevron beside the wordmark when open, under the Luma icon
  when collapsed. There is no drag-to-collapse; the pane's drag-to-resize stays as it is for the open
  pane, and double-click on that handle keeps its reset meaning.
- **The data-location line goes away when collapsed** and becomes part of the Luma icon's hover text.
- **The icons are a small module of hand-drawn inline SVGs**, not an icon library: about sixteen are
  needed, they take their colour from the theme variables, and nothing is added to the dependencies.
- **The collapsed state is per browser** (`localStore`), like the pane width beside it
  (`NAV_PANE_WIDTH_STORAGE_KEY` in `App.jsx`). The shell renders above `UserPreferencesProvider`, which
  is why the width is stored that way too.

## What collapsing touches

The pane is built inline in `App.jsx` (the `<nav>` in the shell). Each kind of content needs its own
collapsed form:

- **The ten page links** (`NAV_LINKS`): an icon each. The hidden label stays the link's accessible name,
  because the Playwright specs find links by role and name.
- **The Tasks count**: a badge on the corner of its icon, still coloured by severity
  (`TASK_BADGE_COLORS`).
- **The sync row** (`components/SyncNavItem.jsx`): its label changes as it works (time since the last
  sync, progress, the finished summary), so collapsed it needs an icon that shows idle, running and
  finished. Its tooltip already carries the detail.
- **The minimized-report pills** (the four `Minimized…NavItem`s, through
  `components/MinimizedReportPill.jsx`): an icon-only form of the pill with its badge. All four use the
  same `↗` today, so each report needs an icon of its own or the collapsed pills cannot be told apart.
- **The footer**: icon forms of the profile switcher, Sign out and Shut down. The profile's inline rename
  cannot fit in the icon column, so it runs from a small popover or opens the pane.
- **Help**: the in-app help that describes the navigation pane changes with it
  (`frontend/src/help/content.jsx`).
- **Docs**: the icon-only pill form gets a line in `shared-components.md`; the collapsed pane is a
  convention for `ui-patterns.md` only if something besides the nav comes to use it.

## Obstacles

- **There is no hover on a tablet.** The icons' hover labels and the Luma icon's data-location text
  cannot be seen there, so the icons have to be recognizable on their own, and the full pane — with the
  data location — is one tap on the toggle away.
- **The page reflows when the pane changes width.** Charts and the windowed lists resize themselves, and
  floating panels stay clamped to the viewport, but this wants a look in the running app at both widths.
