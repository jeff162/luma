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
 *
 * Cross-linking between help topics: use `<HelpLink to="/help/...">` (not the
 * bare react-router `<Link>`) so the "Back to <page>" affordance survives hops
 * between topics; HelpLink forwards the original source path through state.
 */

import HelpLink from './HelpLink.jsx'

export const HELP_TOPICS = [
  {
    id: 'how-fintrack-works',
    title: 'How FinTrack works',
    surfaces: ['Getting started', 'Dashboard'],
    summary: 'FinTrack is for two things: reports (mostly the dashboard) and searching your transaction history. Everything else — accounts, owners, categories, tags, rules — exists to make those two better.',
    body: () => (
      <>
        <p>
          Two jobs sit at the center of FinTrack: <strong>reports</strong> (mostly through the
          dashboard) and <strong>searching</strong> your transaction history. Every other feature —
          accounts, owners, categories, tags, and rules — exists to make those two better, and you
          can pick each one up only when it earns its place in <em>your</em> reports. Nothing has to
          be set up before you start.
        </p>
        <p>It usually comes together in this order, though the order is up to you:</p>
        <ol>
          <li>
            <strong>Bring data in.</strong> Import a CSV file or connect a data source. When the same
            activity arrives from more than one source, the duplicate-detection report surfaces the
            judgment calls so you can build one clean ledger.
          </li>
          <li>
            <strong>Accounts and owners.</strong> Transactions usually arrive tagged with an account;
            an account can matter on its own (a card you use for one purpose) or as a way to attribute
            a transaction to an <em>owner</em> for reports and rules. It is often worth bringing in your
            individual spending sources &mdash; credit cards, P2P / payment accounts &mdash; since they
            carry the richest per-merchant detail. If you also import the bank account that pays them
            off, mark the money-movement group (credit-card payments, account transfers){' '}
            <HelpLink to="/help/exclude-from-totals">excluded from totals</HelpLink> so the same spending
            isn&rsquo;t counted twice and the ledger stays straight.
          </li>
          <li>
            <strong>Categories and groups.</strong> Assign transactions to categories, and categories
            to groups, purely to drive reports and to select related transactions. They have no other
            job. You can start from a common set or build your own.
          </li>
          <li>
            <strong>Tags.</strong> Cross-cutting labels that cut across owner, account, and category —
            think <em>Essential Expenses</em> or <em>Kids</em> — and apply to income and expenses
            alike. See <HelpLink to="/help/tags">how tags work</HelpLink>.
          </li>
          <li>
            <strong>Rules.</strong> How categories and tags get applied to new transactions as they
            arrive (and how merchant names get normalized). More on this below.
          </li>
          <li>
            <strong>The dashboard.</strong> Your reports live here, and it doubles as a way to check
            your data — drill into the largest groups, see the transactions behind them, and fix
            anything miscategorized.
          </li>
        </ol>
        <h4>How rules come into being</h4>
        <p>
          You rarely write rules from scratch. When you categorize a transaction, FinTrack offers to
          turn that action into a rule — give it conditions and actions, apply it to matching
          transactions, and save it. From then on it runs automatically against newly imported data
          (you can turn off rule application, and there is a <em>run categorization</em> button to
          trigger a pass on demand).
        </p>
        <p>
          If you are arriving from another tool where you already curated categories, tell FinTrack
          the import&apos;s data is clean and it will keep those categories; the <strong>Generate
          rules</strong> action then studies those curated transactions and proposes rules that would
          reproduce the same categorization on future, uncategorized data — which you review before
          anything takes effect.
        </p>
        <p>
          And if you are starting fresh with no curated data, you can add a small <strong>starter
          set</strong> of common categories and rules. Rules touch your data, so the starter rules are
          shown as a list you approve before adding — and, like everything here, they can be changed or
          removed later.
        </p>
      </>
    ),
  },
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
          The dashboard’s &quot;Spending by…&quot; picker offers two built-in breakdowns
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
          in an &quot;Alice + Essential&quot; wedge rather than being assigned to one or the other. A
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
  {
    id: 'exclude-from-totals',
    title: 'Excluding a group from totals',
    surfaces: ['Categories (group settings)'],
    summary: 'Mark a category group "Exclude from totals" to keep money movement — credit-card payments, transfers between your own accounts — out of dashboard charts and totals so it is not double-counted.',
    body: () => (
      <>
        <p>
          <strong>Exclude from totals</strong> removes a category group &mdash; and every category under
          it &mdash; from the dashboard&rsquo;s charts and totals. It is a reporting switch, not a delete:
          the transactions still exist and stay searchable, they just don&rsquo;t count toward your
          spending or income figures.
        </p>
        <p>
          The classic case is <strong>money movement that isn&rsquo;t really spending or income</strong>.
          It is often useful to bring in <em>both</em> a credit card and the bank account that pays it off
          &mdash; the card has the detailed, per-merchant transactions, while the bank shows the lump-sum
          payment. If both counted, every purchase would be tallied twice: once as the card charge and
          again as the bank payment. Assigning those <strong>credit-card payments</strong> (and transfers
          between your own accounts) to a category in an excluded group keeps the detail from the card
          while the payment itself drops out of the totals.
        </p>
        <p>
          The built-in <strong>Transfers</strong> group ships with this turned on, so a quick start is to
          categorize credit-card payments and account-to-account transfers there. But the switch works on
          any group, so you can build your own scheme &mdash; e.g. a <em>Reimbursable</em> or
          <em>Investments</em> group you want kept out of the headline numbers.
        </p>
      </>
    ),
  },
]

export const HELP_TOPICS_BY_ID = Object.fromEntries(HELP_TOPICS.map(t => [t.id, t]))
