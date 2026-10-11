# In-page help: an "explain this" mode, and the post-data guided tour

**Not started (2026-09-13).** Two in-page guidance ideas, recorded together because they would share
one mechanism: a way for a page to declare which help topic each of its controls belongs to, so the
guidance can point at the real screen.

## Explain-this mode

A button on any page turns on a mode that outlines every control currently on screen that has a help
topic. Clicking an outlined control opens that topic in place. Pressing the button again, or Escape,
leaves the mode and restores the page.

### Considered instead: a picture of the page in its hub topic

A mockup of the page inside its `page-*` hub topic, with each control linking to its topic, was the
first form of the idea. Two ways to draw it, both turned down in favor of pointing at the real screen:

- **A screenshot with hot spots** looks exact but goes stale whenever the page changes, needs a light and
  a dark version, and nothing notices when it is out of date. The headless suite could regenerate the
  images from demo data, but that adds a pipeline and binary files, and the hot spot coordinates still
  drift.
- **A schematic drawn from labelled boxes** is cheap, follows the theme, and its links are checked by the
  existing help-registry test, but it is still a second copy of the layout that has to be kept in step.

What shipped instead is the cheap half: the Import hub became a set of *on the page → what it is
for* tables, grouped by tab, each row linking its topic. That table is the control-to-topic mapping this
mode would declare in code, so it is the natural page for a first prototype.

### Likely shape

- **Declared at the control.** An attribute on the control naming its topic id (for example
  `data-help-topic`); the mode finds the visible elements carrying it. The existing `FeatureExplainer`
  placements (34 at the time of writing) already name one topic per control and are the first candidates.
- **Opened through the existing in-place viewer** (`useHelpTopicViewer` → `HelpTopicDialog`), so a topic
  opened from the mode behaves exactly like one opened from a `?`: rendered above floating panels, with
  the back trail and the link to the index.
- **Launched from the page header**, beside the page's `?` in `PageHeader`'s `help` slot, following the
  placement convention in `ui-patterns.md` → *Help and contextual explainers*.
- **Guarded like cross-links.** A test that every declared topic id exists, as `content.test.jsx` already
  does for `HelpLink` targets — a declaration naming a renamed topic would otherwise fail silently.

### Design questions still owed

- **What is not on screen.** Controls on another tab, inside a closed dialog or a collapsed card, or not
  rendered at all on an empty page. A fresh install has no import history, so the file-card controls on
  Import — several topics — have nothing to outline, and a new user is exactly who needs this. A
  fallback is needed, such as an "also on this page" list of the topics whose controls are not showing.
- **Crowding.** Some pages carry many topic-bearing controls at once; outlines may need to stay quiet
  until hovered or focused.
- **Keyboard and screen readers.** Outlined controls must be reachable with Tab and announced; a
  pointer-only overlay is not acceptable.
- **Floating panels and dialogs.** Whether the mode reaches into an open floating panel or modal, several
  of which carry `?` launchers of their own (the duplicate-detection report, the Amazon reports).
- **`ContextualExplainer` tips.** Whether the mode shows a page's situational tips too, and how it
  interacts with dismissed ones.
- **Keeping declarations complete.** Declaring a topic on a control with no visible `?` is new; the
  mode is only as complete as those declarations are kept, and no test can find a control that should
  have one and does not.

## Post-data guided tour

Deferred from the onboarding rework, whose first run is data-first — import a file, connect a data
provider, load demo data, or skip (`ui-patterns.md` → *First-run onboarding*). It was recorded only as a
"next step" tour offered once data has arrived; its scope has not been designed.

If picked up, it would most likely be a sequence over the same declarations: step through a chosen set
of controls, possibly across pages, each step highlighting one control and showing its topic's summary.
Building the explain mode's declarations first would make the tour a question of sequence and copy
rather than a second mechanism. The same questions apply, though a tour started after data arrives has
something to point at. Demo data (`backend/db/demo_data.py`) produces import cards, saved data sources
and a flagged duplicate through the real import pipeline, which gives both features a populated page to
show.
