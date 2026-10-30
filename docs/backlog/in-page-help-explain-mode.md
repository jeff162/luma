# In-page help: an "explain this" mode, and a guided tour

Not started. Two in-page guidance ideas that would share one mechanism: a way for a page to declare which
help topic each of its controls belongs to, so the guidance points at the real screen.

## Explain-this mode

A button on any page turns on a mode that outlines every control on screen that has a help topic.
Clicking an outlined control opens its topic in place. Pressing the button again, or Escape, leaves the
mode.

**Why the real screen and not a picture of it.** A mockup of the page inside its `page-*` hub topic was
the first form of the idea. A screenshot with hot spots goes stale whenever the page changes, needs light
and dark versions, and nothing notices when it is out of date. A schematic of labelled boxes is cheap and
follows the theme, but is still a second copy of the layout to keep in step.

**Starting point.** The Import hub topic's *on the page → what it is for* tables, grouped by tab with each
row linking its topic, are the control-to-topic mapping this mode would declare in code. That makes Import
the natural page for a first prototype.

### Likely shape

- **Declared at the control.** An attribute naming its topic id (for example `data-help-topic`); the mode
  finds the visible elements carrying it. The existing `FeatureExplainer` placements already name one
  topic per control and are the first candidates.
- **Opened through the existing in-place viewer** (`useHelpTopicViewer` → `HelpTopicDialog`), so a topic
  opened from the mode behaves exactly like one opened from a `?`.
- **Launched from the page header**, beside the page's `?` in `PageHeader`'s `help` slot
  (`ui-patterns.md` → *Help*).
- **Guarded like cross-links.** A test that every declared topic id exists, as `content.test.jsx` does for
  `HelpLink` targets, since a declaration naming a renamed topic would otherwise fail silently.

### Design questions owed

- **What is not on screen.** Controls on another tab, inside a closed dialog or collapsed card, or absent
  on an empty page. A fresh install has no import history, so the file-card controls on Import have
  nothing to outline, and a new user is who needs this most. Something like an "also on this page" list
  of topics whose controls are not showing.
- **Crowding.** Some pages carry many topic-bearing controls; outlines may need to stay quiet until
  hovered or focused.
- **Keyboard and screen readers.** Outlined controls must be reachable with Tab and announced; a
  pointer-only overlay is not acceptable.
- **Floating panels and dialogs.** Whether the mode reaches into an open floating panel or modal, several
  of which have their own `?` (the duplicate report, the Amazon reports).
- **`ContextualExplainer` tips.** Whether the mode shows a page's situational tips, and how it treats
  dismissed ones.
- **Keeping declarations complete.** The mode is only as complete as the declarations, and no test can
  find a control that should have one and does not.

## Post-data guided tour

A "next step" tour offered once data has arrived (first run is data-first: import a file, connect a
provider, load demo data, or skip). Its scope is not designed.

Most likely a sequence over the same declarations: step through a chosen set of controls, possibly across
pages, highlighting one control at a time and showing its topic's summary. Building the explain mode's
declarations first makes the tour a question of sequence and copy rather than a second mechanism. Demo
data (`backend/db/demo_data.py`) produces import cards, saved data sources and a flagged duplicate through
the real pipeline, which gives both features a populated page to show.
