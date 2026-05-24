// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

/*
 * Help-content registry.
 *
 * Each entry is a self-contained explainer for one feature surface or concept,
 * authored once and rendered from both the inline FeatureExplainer popover and
 * the Help nav route. Keep these tight: a one-line summary that fits a small
 * popover, plus a longer body for the standalone Help page. Cross-link by
 * `id` rather than by route so the content stays portable if the routing
 * shifts later.
 *
 * Adding a new topic:
 *   1. Pick a stable, lowercase-hyphenated `id` (used in popover anchors and
 *      `/help/:topic` URLs).
 *   2. Add an entry below.
 *   3. Drop a `<FeatureExplainer topic="..."/>` next to the feature surface.
 */

import HelpLink from './HelpLink.jsx'

export const HELP_TOPICS = [
  {
    id: 'tags',
    title: 'How tags work',
    surfaces: ['Tag manager (Settings)'],
    summary: 'Tags are cross-cutting labels you can apply at the transaction, category, or group level. A transaction’s effective tags are the union of all three sources.',
    body: () => (
      <>
        <p>
          Tags are lightweight labels separate from the category tree. Use them for any cross-cutting
          dimension you want to report by &mdash; <em>Essential</em> vs everything else, who an
          expense belongs to in a household, business vs personal, vacation buckets, and so on.
        </p>
        <p>
          A tag can be attached at three levels, and a transaction’s <strong>effective
          tags</strong> are the additive union of all three:
        </p>
        <ul>
          <li><strong>Direct (transaction-level)</strong> &mdash; added by a matching rule, or by
            you manually editing one transaction. Manual edits override the rule for that one row.</li>
          <li><strong>Category-level</strong> &mdash; a tag attached to a leaf category propagates
            to every transaction in that category.</li>
          <li><strong>Group-level</strong> &mdash; a tag attached to a category group propagates to
            every transaction in any of the group’s leaves.</li>
        </ul>
        <p>
          Pick the level that matches your intent. A tag like <em>Bills</em> probably belongs on a
          group; a tag like <em>Reimbursable</em> often belongs on individual transactions via a
          rule that recognizes the merchant. Composing across levels is fine &mdash; the same tag
          can be on a group and on individual transactions.
        </p>
        <p>
          Inherited tags can’t be removed from a single transaction today. To opt one out,
          retag at the level the inheritance comes from.
        </p>
        <p>
          See also: <HelpLink to="/help/categories-tags">Tagging categories and groups</HelpLink>{' '}
          &middot; <HelpLink to="/help/dashboard-tag-reports">Dashboard tag reports</HelpLink>
        </p>
      </>
    ),
  },
  {
    id: 'categories-tags',
    title: 'Tagging categories and groups',
    surfaces: ['Categories page right panel'],
    summary: 'Attach tags to a category or group from its right-panel pill row. Tags on a group propagate to every leaf under it; tags on a leaf apply just to that leaf.',
    body: () => (
      <>
        <p>
          The right-hand panel on the Categories page shows the selected category’s tags as
          pills. Click <strong>+ Tag</strong> to attach an existing tag or create a new one inline.
        </p>
        <p>
          When you select a leaf category, you may also see <em>inherited</em> pills (italic, no
          remove button) &mdash; those come from the parent group. To remove an inherited tag,
          select the group itself and remove the tag there; the change automatically propagates.
        </p>
        <p>
          Direct tags can be removed with the <strong>&times;</strong> on each pill. Tags do not
          replace categorization &mdash; they live alongside it &mdash; so a single transaction can
          carry several tags from a mix of category, group, rule, and manual sources.
        </p>
        <p>
          See also: <HelpLink to="/help/tags">How tags work</HelpLink>
        </p>
      </>
    ),
  },
  {
    id: 'dashboard-tag-reports',
    title: 'Dashboard tag reports',
    surfaces: ['Dashboard "Spending by…" picker'],
    summary: 'Save a named breakdown of your spending or income by tag set. Each selected tag becomes a wedge; combinations show up as their own wedge so totals always add to the whole.',
    body: () => (
      <>
        <p>
          The dashboard’s "Spending by…" picker offers two built-in breakdowns
          (<em>group</em>, <em>category</em>) plus any tag reports you save. A tag report is just a
          named set of tags you want as wedges &mdash; for example a <em>Per-owner</em> report
          might select tags Alice, Bob, Shared.
        </p>
        <p>
          Click <strong>+ Tag report</strong> in the picker to build one. The builder shows every
          available tag with a checkbox. <em>Save &amp; display</em> persists the report and adds
          it to the picker for future use; <em>Display</em> shows the report once without saving.
          Right-click (or use the &middot;&middot;&middot; menu) on a saved report’s picker
          row to rename or delete it.
        </p>
        <p>
          Each unique combination of selected tags that any transaction carries becomes its own
          wedge &mdash; so a transaction tagged both <em>Alice</em> and <em>Essential</em> shows up
          in an "Alice + Essential" wedge rather than being assigned to one or the other. A
          transaction matching none of the selected tags falls into a synthetic
          <em> Other / Untagged</em> wedge. Wedges sum to 100% of the matching transactions, so
          the chart is always honest about overlap.
        </p>
        <p>
          See also: <HelpLink to="/help/tags">How tags work</HelpLink>
        </p>
      </>
    ),
  },
]

export const HELP_TOPICS_BY_ID = Object.fromEntries(HELP_TOPICS.map(t => [t.id, t]))
