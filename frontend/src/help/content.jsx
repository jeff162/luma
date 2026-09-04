// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

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
import { APP_NAME } from '../lib/appConfig.js'

/*
 * Help-index sections. The standalone /help page groups topics under these headings, in this
 * order; each topic carries a `section` key matching one of these. Section order here -- not the
 * array order of HELP_TOPICS below -- is what drives how the index reads; within a section,
 * topics appear in their HELP_TOPICS order. The inline FeatureExplainer popovers look topics up
 * by `id` and ignore sections entirely. A topic whose `section` matches nothing here still shows
 * (under a trailing "More" group) rather than silently vanishing.
 */
export const HELP_SECTIONS = [
  {
    key: 'getting-started',
    label: 'Getting started',
    blurb: `What ${APP_NAME} is for, and loading the first data.`,
  },
  {
    key: 'importing',
    label: 'Importing data',
    blurb: 'Mapping files, saving reusable sources, and turning curated data into rules.',
  },
  {
    key: 'duplicates',
    label: 'Duplicates & reconciliation',
    blurb: 'When the same activity arrives from more than one source: what the engine settles on its own, and how to resolve what it cannot.',
  },
  {
    key: 'organizing',
    label: 'Categories & tags',
    blurb: 'Two ways to organize transactions for reports -- a category tree and cross-cutting tags.',
  },
  {
    key: 'transaction-detail',
    label: 'Transaction detail',
    blurb: 'Recording what a transaction does not say on its own -- the paperwork behind it, and purchases that took more than one payment.',
  },
  {
    key: 'recurring',
    label: 'Recurring transactions',
    blurb: 'Transactions that repeat on a schedule -- what the scan finds on its own, and how to declare one it cannot see.',
  },
  {
    key: 'reports',
    label: 'Reports & search',
    blurb: 'Getting answers back out: dashboard breakdowns and searching the history.',
  },
  {
    key: 'access-safety',
    label: 'Access & data safety',
    blurb: 'What sign-in protection and two-factor guard, and what stays in your hands -- the ledger on disk, and backups.',
  },
]

export const HELP_TOPICS = [
  {
    id: 'how-luma-works',
    section: 'getting-started',
    title: `How ${APP_NAME} works`,
    surfaces: ['Getting started', 'Dashboard'],
    summary: `${APP_NAME} is for two things: reports (mostly the dashboard) and searching the transaction history. Everything else -- accounts, owners, categories, tags, rules -- exist to make these two better.`,
    body: () => (
      <>
        <p>
          Two features sit at the center of {APP_NAME}: <strong>reports</strong> (mostly through the
          dashboard) and <strong>searching</strong> the transaction history. Accounts, owners, categories,
          tags, and rules all exist to make those two better, and they can be used or not depending on
          whether they are helpful.
        </p>
        <p>
          A handful of deliberate design choices shape how {APP_NAME} behaves and how it is best
          used -- see <HelpLink to="/help/design-principles">how {APP_NAME} is designed to be
            used</HelpLink>.
        </p>
        <p>
          All of the data remains local unless you move it somewhere else; {APP_NAME} never makes an outgoing
          connection unless specifically requested (eg. downloading
          transactions from a data provider, store a backup on a cloud service).
        </p>
        <p>
          To get started:
          <ol>
            <li>
              Load transactions - Use the Import/Export page or connect a Data source. If there are
              several files to be imported, import them all at once before moving on. If files come from
              different sources accounts in the various input files can be mapped so they match. If this
              is not done during the import process, it can be done later on the Accounts page. If files do
              come from different data sources consider creating saved profiles for them so the import settings
              get applied automatically on subsequent files from the same source.
            </li>
            <li>
              Account Owners - Create the account owner(s) and assign them to accounts. This isn&apos;t
              necessary if accounts will not be assigned owners. If more than one owner is
              created, <strong>shared</strong> becomes available as a choice.
            </li>
            <li>
              Tags - Give some thought as to what kind of reports to generate for and what tags
              might support them. Tags can be created and applied later but it is slightly
              easier to bake them into the rules up front.
            </li>
            <li>
              Create Categories and Rules - if categories are of interest there is a fork in the road here.
              <ol type="a">
                <li>
                  If the imported data was curated and contains useful
                  transaction categorization the next step is to use
                  the <strong>Group imported categories</strong> and <strong>Generate rules</strong> buttons
                  on the Import/Export page to bring in the categories
                  and rules from the prior system.
                </li>
                <li>
                  <p>
                    If not but categories are of interest, the built in set of seed categories and rules can be loaded
                    via the <strong>Add starter categories</strong> button on the Categories page and/or
                    the <strong>Starter rules</strong> button on the Rules page (this button also brings in categories).
                  </p>
                  <p>
                    It is also fine not to load the system categories or rules. It may be useful to define some groups and
                    categories up front, just to give some thought as to how the transactions might be organized, but this
                    can also be done when categorizing uncategorized transactions. It is rarely a good idea to generate
                    rules manually as it is easier to create them as part of categorizing transactions.
                  </p>
                </li>
              </ol>
            </li>
            <li>
              Categorize uncategorized transactions - if categories are of interest the transaction page can
              filter so only uncategorized transactions are displayed. Assigning a transaction to a category triggers
              a <strong>Create Rule</strong> toast which offers to create a rule from the categorization. The form
              offers the opportunity to edit the conditions and actions of the rule and when saving, the rule can be
              applied to all matching transactions.
            </li>
            <li>
              Use the <strong>Dashboard</strong> page to dig into categories to see if things look right. If there are
              uncategorized transactions the transaction report can be sorted by amount which is useful for categorizing
              the largest transactions first. Merchant is also useful to sort by.
            </li>
          </ol>
        </p>
      </>
    ),
  },
  {
    id: 'parts-of-luma',
    section: 'getting-started',
    title: `The parts of ${APP_NAME}`,
    surfaces: ['Getting started'],
    summary: 'A tour of the app -- what each section is for (Import/Export, accounts & owners, categories & groups, tags, rules, the dashboard) and the two ways rules come into being.',
    body: () => (
      <>
        <p>The sections of the Application are:</p>
        <ol>
          <li>
            <strong>Import/Export</strong> Import a CSV file or connect a data source. There is strong
            duplicate detection to deal with overlapping sources or overlapping imports from a signal
            source. When the duplicate-detection code encounters a situation it is not sure how to resolve
            it surfaces the conflict(s) in a duplicate detection report which is launched
            from the file card for the import (on the Import/Export main page).
          </li>
          <li>
            <strong>Accounts and owners.</strong> Transactions usually arrive tagged with an account.
            An account can matter on its own, a card used for a specific purpose, or as a way to attribute
            a transaction to an <em>owner</em> for reports and rules. It can be worth bringing in data from
            the individual spending sources &mdash; credit cards, P2P, loan accounts &mdash; since they
            carry the richest per-merchant detail. The alternative is that everything on the credit card
            will be a monthly lump sum identified in the ledger as a <em>Credit card payment</em>. If the detail
            is not interesting, there is no need to use more than the bank account. If the transactions from
            the actual spending account are imported then to avoid double counting, the <strong>Category </strong>
            which <em>Credit card payment</em>s are assigned to should be a member of a group such
            as <em>Transfers</em> which is marked <strong>Exclude from totals</strong> {' '}
            (<HelpLink to="/help/exclude-from-totals">excluded from totals</HelpLink>).
          </li>
          <li>
            <strong>Categories and groups.</strong> Transactions can be assigned to categories, and categories
            are collected into groups, purely<sup>*</sup> to drive reports and to select related transactions.
            The system contains a seed set of rules and categories which can be used if none are defined.
            <p>
              ----------
              <p>
                <sup>*</sup>The one exception is that a group can be marked <strong>Exclude from totals</strong> (see link
                above) which may be useful even if categories are not being used more generally.
              </p>
            </p>
          </li>
          <li>
            <strong>Tags.</strong> Tags are used to create spending reports that are not otherwise
            available on the dashboard. These are labels used to identify transactions belonging to some
            interesting group across owner, account, and category such
            as <em>Essential Expenses</em> or <em>Kids</em>.
            See <HelpLink to="/help/tags">how tags work</HelpLink>.
          </li>
          <li>
            <strong>Rules.</strong> Rules have a set of matching criteria to select the set of
            transactions they apply to and a set of actions they take when they apply. The
            actions include setting the merchant name, assigning a category or a tag and indicating
            whether the transaction is part of a recurring series. More on this below but if categories are
            important, this is how they are maintained on incoming data. A little bit of time up front
            spent building rules makes the review process of new transactions fairly quick and painless.
          </li>
          <li>
            <strong>The dashboard.</strong> Reports live here, and it doubles as a way to check
            the data -- drill into the largest groups, see the transactions behind them, fix
            anything misclassified.
          </li>
        </ol>
        <h4>How rules come into being</h4>
        <p>
          There are three main ways rules get created:
          <ol>
            <li>
              If data comes from another tool where the transactions have already been carefully categorized, indicate
              that an import&apos;s data is clean and the categories are preserved and imported for use; the <strong>Generate
                rules</strong> action studies these curated transactions and proposes rules that would
              reproduce the same categorization on future, uncategorized data -- which get reviewed before
              anything takes effect.
            </li>
            <li>
              When a transaction is categorized, {APP_NAME} offers to
              turn that action into a rule -- give it conditions and actions, apply it to other matching
              transactions, and save it. From then on it runs automatically against newly imported data
              (Categorizing imported data can be controlled when importing a file and there is
              a <em>run categorization</em> button to trigger a pass on demand).
            </li>
            <li>
              When a transaction is marked as part of a recurring series the way that happens is through the
              Rules editor so the Rules editor is launched filled out with whatever information is available.
            </li>
          </ol>
        </p>
        <p>
          If starting fresh with no curated data, there is a small <strong>starter
            set</strong> of common categories and rules that can be added via buttons on the Rules and Category pages.
          Rules alter the data, so the starter rules are shown as a list for approval before adding.
        </p>
      </>
    ),
  },
  {
    id: 'design-principles',
    section: 'getting-started',
    title: `How ${APP_NAME} is designed to be used`,
    surfaces: ['Getting started'],
    summary: `A few deliberate choices shape how ${APP_NAME} behaves -- categorization that compounds instead of repeating, editing in place, non-destructive toggles, and dedupe that makes overlapping imports safe. Knowing the reasoning makes the rest of the app easier to use.`,
    body: () => (
      <>
        <p>
          {APP_NAME} makes a handful of deliberate choices, all aimed at keeping routine work
          low-friction. It is meant to act as a window into the data and to stay out of the way
          rather than enforce one particular method -- so when something seems like it should be
          possible but is not, that is usually a gap worth reporting rather than an intended limit.
          The reasoning below explains why several things work the way they do, and how to take
          advantage of them.
        </p>
        <ul>
          <li>
            <strong>Categorization compounds; it never repeats work.</strong> Categorizing a
            transaction is not a one-off edit -- it can become a rule that reproduces the same
            decision across every matching transaction, now and on future imports. So time spent
            refining a few good rules pays off more than re-touching individual rows. See{' '}
            <HelpLink to="/help/parts-of-luma">how rules come into being</HelpLink>.
          </li>
          <li>
            <strong>Editing happens where the data is shown.</strong> Wherever a thing is viewed it
            can usually be changed in place, and anything assignable -- a category, a tag, an
            owner -- can be created from the same control. There is rarely a need to leave for a
            separate settings screen to make a change, so the first place to look is the data itself
            rather than a menu.
          </li>
          <li>
            <strong>Each feature is adopted only when it earns a place.</strong> Reports and search
            are the two things {APP_NAME} exists to do well; accounts, owners, categories, tags, and
            rules all exist to make those better. None are mandatory, and each can be left aside
            until it pays off in a report worth having -- there is no obligation to fill everything
            in up front.
          </li>
          <li>
            <strong>Changes are reversible, and rarely destructive.</strong> Most actions can be
            undone, redone, or adjusted later, and several that look like deletions are really
            reporting switches: a group{' '}
            <HelpLink to="/help/exclude-from-totals">excluded from totals</HelpLink> still keeps its
            transactions, and a{' '}
            <HelpLink to="/help/removed-as-duplicates">removed duplicate</HelpLink> is still listed
            on its file. Little is permanent, so experimenting is safe.
          </li>
          <li>
            <strong>Overlapping sources are safe to import.</strong> Strong duplicate detection is
            what makes it reasonable to bring in the same activity from more than one place -- a card
            and the bank account that pays it off, or an aggregator that has seen both. So importing
            liberally for richer detail is encouraged; the{' '}
            <HelpLink to="/help/duplicate-report">duplicate-detection report</HelpLink> settles the
            overlaps.
          </li>
          <li>
            <strong>Ambiguous cases are surfaced, not guessed.</strong> Where more than one reading
            is reasonable -- which account a transaction belongs to, whether a row is a duplicate,
            how something should be categorized -- {APP_NAME} asks rather than deciding silently, and a
            manual choice overrides what a rule would otherwise do. A prompt asking for a decision is
            doing real work, and manual corrections stick.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'tags',
    section: 'organizing',
    title: 'How tags work',
    surfaces: ['Tag manager (Settings)'],
    summary: 'Tags are cross-cutting labels applied at the transaction, category, or group level. A transaction’s effective tags are the union of all three sources.',
    body: () => (
      <>
        <p>
          Tags are lightweight labels separate from the category tree. Use them for any cross-cutting
          dimension to report by &mdash; <em>Essential</em> vs everything else, who an
          expense belongs to in a household, business vs personal, vacation buckets, and so on.
        </p>
        <p>
          A tag can be attached at four levels, and a transaction’s <strong>effective
            tags</strong> are the additive union of all four:
        </p>
        <ul>
          <li><strong>Direct (transaction-level)</strong> &mdash; added by a matching rule, or by
            manually editing one transaction. Manual edits override the rule for that one row.</li>
          <li><strong>Category-level</strong> &mdash; a tag attached to a leaf category propagates
            to every transaction in that category.</li>
          <li><strong>Group-level</strong> &mdash; a tag attached to a category group propagates to
            every transaction in any of the group’s leaves.</li>
          <li><strong>Account-level</strong> &mdash; a tag attached to an account (on the Accounts
            page) propagates to every transaction in that account. For a merged account the top-level
            account’s tags carry to its child accounts’ transactions, while a merged child’s own tags
            stay dormant until it is detached.</li>
        </ul>
        <p>
          Pick the level that matches the intent. A tag like <em>Bills</em> probably belongs on a
          group; a tag like <em>Reimbursable</em> often belongs on individual transactions via a
          rule that recognizes the merchant. Composing across levels is fine &mdash; the same tag
          can be on a group and on individual transactions.
        </p>
        <p>
          To hide an inherited tag on a single transaction, uncheck it in that transaction’s tag
          picker (the row’s tag popover or the transaction editor). It stays on every other
          transaction that inherits it, and a strike-through <em>hidden here</em> entry in the picker
          re-checks to restore it. Removing the tag from the category, group, or account instead drops
          it from every transaction under that level.
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
    section: 'organizing',
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
          When a leaf category is selected it, the assigned tags are displayed as well as
          any <em>inherited</em> tags from the group. These are displayed in italics and do
          not have a remove button.  To remove an <em>inherited</em> tag,
          select the group itself and remove the tag there; the change automatically propagates.
        </p>
        <p>
          Direct tags can be removed with the <strong>&times;</strong> on each pill. A single transaction can
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
    section: 'reports',
    title: 'Dashboard tag reports',
    surfaces: ['Dashboard "Spending by…" picker'],
    summary: 'Save a named breakdown of your spending or income by tag set. Each selected tag becomes a wedge; combinations show up as their own wedge so totals always add to the whole.',
    body: () => (
      <>
        <p>
          The dashboard’s &quot;Spending by…&quot; picker offers two built-in breakdowns
          (<em>group</em>, <em>category</em>) plus saved tag reports. A tag report is a
          named set of tags that become the wedges along with the <em>remaining</em> category. For example
          a <em>Per-owner</em> report might select tags Alice, Bob, Shared.
        </p>
        <p>
          Click <strong>+ Tag report</strong> in the picker to build one. The builder shows every
          available tag with a checkbox. <em>Save &amp; display</em> persists the report and adds
          it to the picker for future use; <em>Display</em> shows the report once without saving.
          Right-click (or use the &middot;&middot;&middot; menu) to rename or delete a saved report.
        </p>
        <p>
          Each unique combination of selected tags that any transaction carries becomes its own
          wedge &mdash; so a transaction tagged both <em>Alice</em> and <em>Essential</em> shows up
          in an &quot;Alice + Essential&quot; wedge rather than being assigned to one or the other. A
          transaction matching none of the selected tags falls into a synthetic
          <em> Other / Untagged</em> wedge. Wedges sum to 100% of the matching transactions.
        </p>
        <p>
          See also: <HelpLink to="/help/tags">How tags work</HelpLink>
        </p>
      </>
    ),
  },
  {
    id: 'dashboard-cash-flow',
    section: 'reports',
    title: 'Cash flow',
    surfaces: ['Dashboard frame selector'],
    summary: 'A third dashboard frame beside Expenses and Income: what came in against what went out. A single period draws it as a flow diagram; Trends draws the two directions as bars around a zero line.',
    body: () => (
      <>
        <p>
          <strong>Cash flow</strong> sits beside <em>Expenses</em> and <em>Income</em> in the
          dashboard&rsquo;s frame selector. Where those two report one side of the ledger, this one
          reports both at once: money in against money out, and the net between them. The period,
          the filter chips and the breakdown picker all work exactly as they do in the other two
          frames.
        </p>
        <p>
          For a <strong>single period</strong> the frame draws a flow diagram &mdash; sources on the
          left, the period in the middle, destinations on the right. The width of each band is the
          amount, and the label beside it carries the figure. Clicking a band opens what it is made
          of, the same drill the pie wedges offer: a group opens its categories, a category opens its
          transactions. Where a long tail of small buckets would be too thin to read, the remainder
          collapses into a single <em>Other</em> band that opens one level further in.
        </p>
        <p>
          The two sides rarely balance, and the difference is the point. A period that took in more
          than it spent ends in a <strong>Net saved</strong> band; one that spent more is funded by
          a <strong>Net drawdown</strong> band on the incoming side. That band stands for the
          difference itself rather than for any transactions, so it is the one band that does not
          open.
        </p>
        <p>
          Under <strong>Trends</strong> the same frame becomes a bar per month around a zero line
          &mdash; money in above it, money out below, with the net drawn across them and the average
          net marked. Clicking a month opens its transactions; double-clicking switches to the
          single-period view for that month.
        </p>
        <p>
          A category&rsquo;s <strong>net</strong> for the period decides which side it lands on, not
          what kind of category it is. A month where returns outweighed purchases puts that category
          on the incoming side; income clawed back lands on the outgoing side. This is also why the
          figures net rather than gross: a purchase and its later refund in the same category and
          period show as the difference, not as two separate movements.
        </p>
        <p>
          Only one thing is excluded, and it is the same switch every other report
          uses: <HelpLink to="/help/exclude-from-totals">groups excluded from totals</HelpLink>.
          Transfers between accounts and credit-card payments belong there, and once they are, they
          drop out of cash flow as well &mdash; without which every card payment would read as money
          leaving on top of the purchases it settled.
        </p>
        <p>
          Tag reports are not offered in this frame. A tag signature mixes categories from both
          directions, so it has no single direction to net; switching back to <em>Expenses</em>
          or <em>Income</em> restores the saved report.
        </p>
        <p>
          See also: <HelpLink to="/help/exclude-from-totals">Excluding a group from totals</HelpLink>
        </p>
      </>
    ),
  },
  {
    id: 'exclude-from-totals',
    section: 'organizing',
    title: 'Excluding a group from totals',
    surfaces: ['Categories (group settings)'],
    summary: 'Mark a category group "Exclude from totals" to keep money movement -- credit-card payments, transfers between your own accounts -- out of dashboard charts and totals so it is not double-counted.',
    body: () => (
      <>
        <p>
          <strong>Exclude from totals</strong> removes a category group and the categories under
          it from the dashboard&rsquo;s charts and totals. It is a reporting switch, not a delete:
          the transactions still exist and stay searchable, they just don&rsquo;t count toward the
          spending or income figures.
        </p>
        <p>
          The use case is for <strong>money movement that isn&rsquo;t spending or income</strong>.
          It is often useful to bring in data from <em>both</em> a credit card and the bank account that pays it off.
          The card has the individual transaction information and the bank account probably has other useful
          transactions which would not be captured otherwise. The challenge is that the bank account also has a
          payment to the credit-card company which needs to be eliminated or the debits will be doubly counted.
          Another major use case is for transfers between accounts. If money is kept in some high(er) yielding
          account and transferred in to cover spending periodically, it probably should not be counted as
          income. Assigning those <strong>credit-card payments</strong> and <strong>transfers
            between accounts</strong> to a category in an group excluded from the totals keeps the ledger clean. Often a
          surprising spending level or imbalance in income/expenses can be attributed to something not being
          excluded from the total that should have been.
        </p>
        <p>
          The built-in <strong>Transfers</strong> group ships with this turned on, so a quick start is to
          either use the pre-built categories under it, or create new categories under it, and use them for
          credit-card payments and account-to-account transfers. However, the switch works on
          any group, and can be disabled on <strong>Transfers</strong> if desired. This is simply the
          default configuration.
        </p>
      </>
    ),
  },
  {
    id: 're-categorizing',
    section: 'organizing',
    title: 'What changes a transaction’s category',
    surfaces: ['Rules page'],
    summary: 'Run categorization re-applies rules but never disturbs a category set by hand or kept from a trusted import; applying a rule to its matching transactions is full-force and overrides them. A closing section ranks the categorization sources for anyone who wants the full model.',
    body: () => (
      <>
        <p>
          A transaction’s category can come from a few different places, and the two bulk actions that
          re-categorize -- <strong>Run categorization</strong> and a rule’s <strong>apply to matching
            transactions</strong> -- treat those origins differently. The practical effect of each is
          below; a closing section ranks the sources in full for anyone who wants it.
        </p>
        <h4>Run categorization</h4>
        <p>
          The <strong>Run categorization</strong> button (on the Rules page) re-applies every rule
          across the whole ledger, but only to rows that are <strong>not pinned</strong> -- those
          categorized by a rule, and those still uncategorized. It deliberately leaves alone anything
          categorized <em>by hand</em> or kept from a <em>trusted import</em>. It only ever <em>sets</em>
          or <em>changes</em> a category, never removes one: a rule-assigned row that no longer matches
          any rule <strong>keeps</strong> its category, so deleting or narrowing a rule doesn&rsquo;t
          silently un-categorize the transactions it already handled. It is the pass to run after adding
          or changing rules, to refresh categorization without disturbing earlier work.
        </p>
        <p>
          To deliberately <em>undo</em> a rule&rsquo;s categorizations -- when a rule was wrong -- use the{' '}
          <em>re-evaluate this rule&rsquo;s transactions</em> option offered when you delete or edit a
          rule. It re-runs just those rows against the remaining rules, so they fall to another matching
          rule or to uncategorized, rather than keeping the removed rule&rsquo;s category.
        </p>
        <h4>Apply a rule to its matching transactions</h4>
        <p>
          When a rule is saved -- for example from the toast offered after categorizing a transaction --
          it offers to apply to every transaction its matcher catches: the keyword together with any
          owner, account, or amount limits. This apply is <strong>full force</strong>. It claims all
          matching rows and sets them to the rule’s category, <strong>including rows categorized by hand
            or by a trusted import</strong>. It is the one bulk action that overrides a manual edit, so
          the match count is worth a glance before applying if manual edits might be caught in it.
        </p>
        <h4>How categorization sources rank</h4>
        <p>
          Every categorized transaction records where its category came from, and whether that origin is
          protected from automatic re-categorization. From strongest to weakest:
        </p>
        <ul>
          <li><strong>Manual</strong> -- set by hand on the transaction. Protected from automatic
            re-runs; changed afterward only by another manual edit or a full-force rule apply.</li>
          <li><strong>Trusted import</strong> -- the category came from a file imported with
            <em> use the categories present in the data</em>. Also protected from automatic re-runs, but
            a rule apply can reclaim it (turning it into a rule categorization), and the Generate-rules
            conflict screen can re-categorize it in place -- see below.</li>
          <li><strong>Rule</strong> -- assigned by a matching rule. Not pinned, so Run categorization
            re-evaluates it (it can move to another rule, but is never cleared) and a full-force apply
            overwrites it; it is reverted only by the opt-in <em>re-evaluate</em> when the rule is deleted
            or edited.</li>
          <li><strong>Uncategorized</strong> -- no category yet; any rule is free to claim it. (A row whose
            imported category was <em>cleared</em> when a suggested rule was rejected sits here too: rules
            can categorize it, but the discarded file label is kept on the row and never re-applied.)</li>
        </ul>
        <p>
          The asymmetry is the part to remember: <strong>Run categorization</strong> respects the two
          protected origins, while a rule’s <strong>apply to matching</strong> does not.
        </p>
        <p>
          One deliberate exception lives on the{' '}
          <HelpLink to="/help/generate-rules">Generate-rules conflict screen</HelpLink>:
          re-categorizing a row there corrects the file’s category and the row <em>keeps</em> its
          trusted-import weight (and keeps informing rule suggestions). Only <strong>Preserve</strong>
          turns such a row into a manual exception. It is the one place a trusted-import categorization
          is edited while staying trusted-import.
        </p>
        <p>
          A <HelpLink to="/help/transaction-splits">split transaction</HelpLink> sits outside all of this.
          Its categorization is the set of items it was divided into, so both passes leave it alone --
          even a full-force rule apply, which reports how many it skipped rather than overwriting them.
        </p>
        <p>
          To check a single transaction’s current source, open its detail panel: a small pinned label
          sits beside the category, and the details show a <em>Categorized by</em> line naming the
          source -- a rule, a manual edit, or the category present in the source data.
        </p>
      </>
    ),
  },
  {
    id: 'rule-precedence',
    section: 'organizing',
    title: 'When two rules match the same transaction',
    surfaces: ['Rules page'],
    summary: 'Rules are never ordered by hand -- the most specific one wins, on a fixed ranking that puts scope first, then keyword length, then the narrower amount range. Two situations are worth a look and the Rules page can list them on demand: amount ranges that overlap without one containing the other, which nothing can settle on its own and which is resolved by refining the conditions, and merchant names where one contains the other, which is fine but does not always resolve the way it reads -- and where a rule that files nothing differently can be deleted outright.',
    body: () => (
      <>
        <p>
          More than one rule can match a transaction, and there is no priority list to maintain. The
          <strong> most specific</strong> rule wins, ranked in a fixed order: a rule scoped to an owner
          beats one that is not, then a rule pinned to an account, then one scoped to an account type,
          then the <strong>longer keyword</strong>, and last the <strong>narrower amount range</strong>.
          The order matters as much as the terms -- scope is settled before keyword length, and keyword
          length before amount.
        </p>
        <p>
          Narrower on the amount axis means the <em>smaller range</em>, not the rule with more limits
          set. A rule for charges over $3,000 matches strictly fewer transactions than one for charges
          over $300, so it wins wherever both apply -- which is what makes a single biller&rsquo;s
          several bills separable by size, one rule per band.
        </p>
        <h4>Checking for rules that compete</h4>
        <p>
          <strong>Check overlaps</strong> on the Rules page lists the pairs that can both claim
          a transaction. Running the check changes nothing on its own; the panel it opens reports what it
          found, and each rule can be opened for editing from there. Two kinds of finding appear, and
          they mean opposite things.
        </p>
        <ul>
          <li>
            <strong>Amount ranges that overlap</strong> -- two rules for the same merchant whose ranges
            cross without one sitting inside the other, such as $300 to $4,000 against $3,000 and up. A
            $3,500 charge matches both and neither rule is the more specific one, so which of them wins
            is arbitrary. This is the finding that needs attention, and the way to settle it is to refine
            the two rules&rsquo; conditions until only one of them applies -- deleting one is choosing a
            winner rather than removing the ambiguity. Note that both limits are inclusive, so capping
            one rule at exactly the figure the other starts at still leaves that single amount claimed
            twice.
          </li>
          <li>
            <strong>Merchant matchers that nest</strong> -- one rule&rsquo;s keyword contained in
            another&rsquo;s, such as <em>northgate</em> and <em>northgate prime</em>. Nothing is wrong
            here, and it is listed only so the outcome is visible: usually the longer keyword wins, but
            because scope is settled first, a short keyword scoped to an owner or an account takes those
            transactions from a longer keyword that is global. Each pair names the rule that wins.
          </li>
          <li>
            <strong>A nesting pair can also be surplus.</strong> Where both rules file to the same
            category and carry the same owner, account and debit/credit limits, the narrower one changes
            nothing -- the broader rule would file those transactions identically -- so the finding
            offers to <strong>delete</strong> it, recoverable from the rules trash. The offer appears on
            the narrower rule alone: removing the broader one would leave every transaction the narrower
            keyword does not cover without a rule. It also appears only where the two really are
            interchangeable, so a narrower rule filing somewhere else, or scoped differently, is doing
            work of its own and is listed without the offer. Where the two differ in a rename or a tag,
            the finding says what those transactions would gain or lose before anything is removed.
          </li>
        </ul>
        <p>
          Plenty of the nesting pairs are deliberate, so those can be <strong>dismissed</strong> -- an
          acknowledgement, not a fix, which drops the pair from the list and from the counts so what is
          left is what still wants a decision. Nothing is lost: <em>Show dismissed</em> brings the
          acknowledged set back, and each one can be restored. A dismissal covers the situation it was
          made about rather than the pair of rules forever, so an edit that changes what the finding says
          -- a narrower rule that becomes surplus and can now be deleted -- raises it again.
        </p>
        <p>
          <strong>Overlapping amount ranges cannot be dismissed.</strong> Every other finding is
          something to know about, but an overlap means it is genuinely undecided which of the two rules
          applies to a charge in the shared band, and no acknowledgement makes that decided. Those stay
          listed until the conditions are refined.
        </p>
        <p>
          Ranges where one sits entirely inside the other are deliberately not reported. That case has a
          clear answer already -- the inner range wins -- and it is the recommended way to split one
          merchant&rsquo;s charges across categories.
        </p>
      </>
    ),
  },
  {
    id: 'transaction-splits',
    section: 'organizing',
    title: 'Splitting one transaction across categories',
    surfaces: ['Transactions (row menu, Split marker)', 'Transaction detail (Split...)'],
    summary: 'A purchase that spans categories -- part groceries, part hardware -- stays one transaction with its amount divided into items, each with its own category. The amounts have to account for the transaction exactly. Reports count each item under its own category, while the ledger still shows one row for the purchase.',
    body: () => (
      <>
        <p>
          One trip to a warehouse store can be groceries and a winter coat; one hardware run can be half
          garden supplies. Filing the whole amount under a single category overstates that category and
          leaves the other empty, which is the sort of quiet error that only shows up as a puzzling
          dashboard months later.
        </p>
        <p>
          A <strong>split</strong> keeps the purchase as <em>one</em> transaction and divides its amount
          into <strong>items</strong>, each with its own category, its own amount, and an optional
          description. It deliberately does not create child transactions: the ledger still shows one row
          for one purchase, because that is what happened.
        </p>

        <h4>Building one</h4>
        <p>
          The editor opens three ways -- from the row&rsquo;s right-click menu
          (<strong>Split&hellip;</strong>, or <strong>Edit split&hellip;</strong> on one already split),
          from the <strong>Split (N)</strong> marker that a split row shows in its category column, or
          from the <strong>Split&hellip;</strong> button beside the category in the transaction detail
          panel. All three land in the same dialog.
        </p>
        <p>
          It reads as a small ledger -- <em>Description</em>, <em>Category</em>, <em>Amount</em> -- in the
          same order the transaction list uses. The description is optional and names what that item
          covers, which is worth filling in: without it a saved split is a column of amounts with no
          record of why each was set. <strong>+ Item</strong> adds another line, and a split needs at
          least two.
        </p>
        <p>
          <strong>Remaining</strong> counts down as the amounts are filled in, and turns
          into <strong>Fully allocated</strong> when the items account for the transaction exactly.
          <strong> Save split</strong> stays unavailable until then, so whether a split is finished is
          answered on screen rather than by a save that comes back refused.
          <strong> Add remainder to selected</strong> drops whatever is left into the amount last worked
          in -- useful for the final line -- and offers to put the previous figure back if that was not
          what was wanted.
        </p>

        <h4>What the editor will not accept</h4>
        <ul>
          <li>
            <strong>The items must add up to the transaction, to the cent.</strong> A split that does not
            balance would make the ledger disagree with the bank.
          </li>
          <li>
            <strong>Every item points the same way as the transaction</strong> -- all money out, or all
            money in. A refunded item within a purchase is not currently expressible.
          </li>
          <li>
            <strong>An item names a category, not a group</strong> -- the same rule ordinary
            categorization follows.
          </li>
        </ul>
        <p>
          Two items <em>may</em> name the same category, and that is on purpose rather than an oversight.
          Two things bought together often classify alike, and folding them into one line would throw away
          exactly the detail a split exists to keep -- two records at two prices are two purchases.
        </p>

        <h4>Splitting an imported order</h4>
        <p>
          Where the transaction came from a marketplace order whose per-item detail was imported, the
          editor opens with one line per item already filled in, and <strong>shows its working</strong>:
          each item&rsquo;s list price beside the share worked out from it, against the amount actually
          paid. The two differ because list prices exclude tax, shipping and discounts -- so they are used
          as <em>proportions</em> rather than as amounts. <strong>Use items</strong> applies the proposal,
          and every figure stays editable afterwards.
        </p>

        <h4>How a split transaction reads afterwards</h4>
        <p>
          In the transaction list the category column shows <strong>Split (N)</strong> in place of a
          category, since there is no single category to show. Hovering it lists the items and their
          amounts; clicking it reopens the editor.
        </p>
        <p>
          The ledger shows the transaction <em>once</em>, at its full amount. Inside a report or a
          category drill-down it appears instead as the <em>item</em> that matched, at that
          item&rsquo;s amount -- which is what makes the rows in a drill-down add up to the total above
          them. Opening the same transaction&rsquo;s detail panel shows the whole amount again. That
          difference is intended: one is the purchase, the other is the part of it that belongs to the
          category being looked at.
        </p>
        <p>
          Tags behave the way they read. A tag put on the transaction applies to the whole thing and to
          every item; a tag inherited from a category follows each item&rsquo;s own category, so a split
          transaction can contribute to two different tag totals. See{' '}
          <HelpLink to="/help/tags">how tags work</HelpLink>.
        </p>

        <h4>Undoing it</h4>
        <p>
          <strong>Remove split</strong> returns the transaction to a single category -- the one it carried
          before it was split, which is kept for exactly this. Assigning a single category to a split row
          any other way is refused rather than silently discarding the items, so the editor is always the
          way in.
        </p>
        <p>
          Automatic categorization leaves a split alone. <strong>Run categorization</strong> skips it, and
          even applying a rule to its matching transactions -- which otherwise overrides a category set by
          hand -- will not overwrite one, reporting how many it left instead. A split is hand-built work
          with no other record of it. See{' '}
          <HelpLink to="/help/re-categorizing">what changes a transaction&rsquo;s category</HelpLink>.
        </p>
      </>
    ),
  },
  {
    id: 'reimbursable-expenses',
    section: 'organizing',
    title: 'Money that comes back later',
    surfaces: ['Transactions (Reimbursements)', 'Transaction detail (Reimbursement)', 'Transactions (↩ marker)', 'Tasks'],
    summary: 'Concert tickets bought for friends, a work expense claimed afterwards. The part owed back goes into a category under the Reimbursable group, which keeps it out of spending totals until it is resolved -- so the month of the purchase reports only what was really spent. Linking the expense to the repayment tracks what is still owed; completing it closes the record and moves any difference into a real category. Anything outstanding longer than expected is raised on Tasks, so an expense that is never chased cannot quietly understate a month for good.',
    body: () => (
      <>
        <p>
          Some money leaves as an expense and comes back weeks or months later. Three concert tickets on
          one card charge with two of them bought for friends; a work expense paid personally and claimed
          afterwards. Both movements are recorded correctly, and the totals still mislead: the month of
          the purchase reports the whole amount as spending, and the month the money returns reports an
          inflow that is not income.
        </p>
        <p>
          The fix is to park the part that is owed back somewhere that does not count. A seeded{' '}
          <strong>Reimbursable</strong> group sits alongside the other category groups and is excluded
          from totals, exactly as <strong>Transfers</strong> is. Money allocated to a category inside it
          drops out of spending until it is resolved -- so February reports what was actually spent, July
          reports no income, and the balance of the group is what is still owed.
        </p>

        <h4>Naming the categories inside it</h4>
        <p>
          The group ships empty on purpose. Its categories are the user&rsquo;s own, and the useful way to
          name them is for <em>what the money is for</em> -- <em>Concert tickets</em>,{' '}
          <em>Work expenses</em>, <em>Lunches</em> -- rather than for where it has got to.
        </p>
        <p>
          A name such as &ldquo;awaiting reimbursement&rdquo; describes a <em>state</em>, and a state
          name stops being true the moment the state changes: every repaid transaction sitting in it is
          then filed under a description that no longer applies. The group already says the money is owed
          back, so the category&rsquo;s job is to say what it was. Named that way it stays accurate for
          good, and a finished reimbursement is still where it can be found again.
        </p>

        <h4>Recording one</h4>
        <p>
          A wholly reimbursable expense is categorized straight into one of those categories. Where only
          part of it is owed back -- one ticket kept, two bought for friends --{' '}
          <HelpLink to="/help/transaction-splits">split the transaction</HelpLink> and put the part owed
          back into the reimbursable category, leaving the rest where it belongs. Splitting is also what
          allows one charge to be owed by two different people: two items, one for each.
        </p>
        <p>
          The repayment, when it arrives, is categorized into a reimbursable category too. That is what
          keeps it out of income, and what lets the two cancel.
        </p>

        <h4>Tracking who owes what</h4>
        <p>
          Reporting is already correct at this point with nothing linked -- the numbers do not depend on
          it. Linking answers a different question: which repayment settles which expense, and how much is
          still outstanding.
        </p>
        <p>
          The transaction detail panel shows a <strong>Reimbursement</strong> section on any transaction
          holding money in the group, and what it offers follows the direction of the money. On an
          expense it is <strong>Expect $&hellip; back</strong>, which starts a record. On money that came
          in it is <strong>Match $&hellip; to an expense</strong>, which lists the open records and the
          expenses nothing has claimed yet &mdash; picking one pairs them in a single step. Where a
          transaction is divided, the portions are offered as toggles and any combination can be chosen;
          several portions become one claim for their total.
        </p>
        <p>
          A reimbursement covers a <em>portion</em> of a transaction rather than the whole row, which is
          what allows one charge split between two people to be two separate records, and one deposit to
          repay both of them at once. Each record takes a name &mdash; a person, an employer, an
          occasion &mdash; which is what identifies it everywhere it appears.
        </p>
        <p>
          Tracking is optional. An expense sitting in the group is already counted as outstanding with no
          record at all; a record adds the two things the category cannot &mdash; a name, and the pairing
          that completing requires.
        </p>

        <h4>Seeing what is outstanding</h4>
        <p>
          <strong>Reimbursements</strong> on the Transactions page &mdash; and on the Categories page
          while the reimbursable group or one of its categories is selected &mdash; lists everything
          still owed in two columns: <strong>Expected</strong> on the left, holding both tracked records
          and expenses nothing has claimed yet, and <strong>Received</strong> on the right. A payment can
          be dragged from the right onto whatever it repays. An untracked row there is not a problem to
          fix -- it is where every reimbursable sits between the purchase and the repayment. The total of
          both columns is the balance of the group.
        </p>
        <p>
          In the transaction list a <strong>&#8617;</strong> marker on a row opens its reimbursement
          directly, dimmed once that reimbursement is finished.
        </p>

        <h4>Being reminded about one</h4>
        <p>
          An expense that is never chased is the one way this arrangement can still mislead: money parked
          in the group stays out of spending totals for as long as it sits there, so a repayment that
          never arrives quietly understates a month for good. A receivable that has been outstanding
          longer than expected therefore appears on the Tasks page.
        </p>
        <p>
          How long is &ldquo;longer than expected&rdquo; is set at the foot of the{' '}
          <strong>Reimbursements</strong> report, and it is measured from the date of the transaction
          rather than from when the record was made -- an expense entered months after the fact is
          already overdue, and recording it should not push the reminder further away. Thirty days suits
          a work expense; a set of tickets that will not be settled until the night itself is the case
          for setting a date directly on the record instead. <strong>0</strong> switches the default off
          altogether, and records with their own dates still work.
        </p>
        <p>
          Each record carries its own answer: the default, a chosen date, or no reminder at all. A due
          record offers <strong>Not yet</strong>, which pushes it out without any further decision --
          most of the time a reminder needs nothing more than that. Money that has not been tracked has
          no record to hold a date, so it follows the default until it is tracked.
        </p>
        <p>
          Where more than one person is set up as an owner, the reminders arrive as one task per owner,
          based on the account each transaction sits on. That way one person&rsquo;s outstanding expenses
          can be worked through without wading through another&rsquo;s. Every task is visible to
          everyone; the split is there to make them separable, not private.
        </p>

        <h4>Finishing one</h4>
        <p>
          <strong>Complete</strong> closes the record. What it does depends on whether the two sides
          balance, and the button is emphasized only in the case where nothing has to be decided.
        </p>
        <ul>
          <li>
            <strong>Repaid in full</strong> -- nothing moves. The two sides already cancel, so completing
            only records that it is finished, and it drops off the outstanding list.
          </li>
          <li>
            <strong>Repaid short</strong> -- the shortfall was really spent, so it moves onto the expense
            under a category chosen at that point. This updates the month the expense is in, which is the
            intended effect: that is what the purchase actually cost once the repayment is known to be
            final.
          </li>
          <li>
            <strong>Repaid over</strong> -- the surplus arrived with the overpayment, so it is
            booked against the repayment, in that month. The original expense is left alone.
          </li>
          <li>
            <strong>Never repaid</strong> -- the whole amount was spending after all, and completing
            records it as such. The button stays available but unemphasized, since a reimbursement with
            nothing linked against it is far more often unfinished than written off.
          </li>
        </ul>
        <p>
          Any amount left over has to be given a category, so there is no way to close a reimbursement
          leaving money unaccounted for in the group. <strong>Reopen</strong> reverses a completion
          exactly, putting back whatever it moved.
        </p>
        <p>
          Completed reimbursements stay in the category they were already in. Their two sides cancel, so
          they never distort what the group says is outstanding, and leaving them put is what keeps them
          findable.
        </p>

        <h4>What the group will not allow</h4>
        <p>
          The <strong>Reimbursable</strong> group can be renamed and its contents are entirely the
          user&rsquo;s to add to, rename and remove. The group itself cannot be deleted, moved inside
          another group, or counted toward spending totals: each of those would either strand money owed
          back where nothing can find it, or silently restore the overstatement the group exists to
          remove.
        </p>
      </>
    ),
  },
  {
    id: 'duplicate-report',
    section: 'duplicates',
    title: 'Reading the duplicate-detection report',
    surfaces: ['Import / Export (file ↗ report)', 'Duplicate-detection report'],
    summary: 'When the same activity arrives from more than one source, this report resolves the clear cases and groups the rest into pills. Review is an undecided match that needs a decision — and the only category counted as pending work (the file’s “to review” count and the Tasks warning). Rejected · review (Matched nearby date, No specific match) are already rejected and advisory: examine it, Import anyway if it shouldn’t have been rejected, or Mark reviewed. Click a pill to show just that group; hover a pill for a short explanation.',
    body: () => (
      <>
        <p>
          {APP_NAME} builds one clean ledger out of several sources over time, and the same activity often
          arrives more than once &mdash; once from a card, again from the bank that pays it off, or from an
          aggregator that has seen both. The dedupe engine settles the clear, high-confidence cases on its
          own and surfaces the rest here, grouped into pills along the top. They fall into two kinds:
        </p>
        <ul>
          <li><strong>Review</strong> &mdash; an undecided match that <em>needs a decision</em>, usually a{' '}
            <HelpLink to="/help/cross-account-duplicates">cross-account duplicate</HelpLink>. This is the
            category that counts as <strong>pending work</strong>: it drives the file&rsquo;s
            &ldquo;to review&rdquo; count and the &ldquo;Possible duplicate transactions&rdquo; item on the
            Tasks page.</li>
          <li><strong>Rejected &middot; review</strong> &mdash; <strong>Matched nearby date</strong> and
            <strong> No specific match</strong>. These were already rejected at import and are
            <em> advisory</em> &mdash; they do <strong>not</strong> count as pending work. Examine them to
            confirm the rejection was right; a row that should <em>not</em> have been rejected can be kept
            with <strong>Import anyway</strong>, and the rest can be left alone or cleared from the pills
            with <strong>Mark reviewed</strong> (in bulk). Often a <strong> No specific match</strong> transaction
            can be matched to a transaction further out than the pairing window reaches, but sometimes it really is a
            transaction which should be included. See{' '}
            <HelpLink to="/help/covered-range-review">covered-range review</HelpLink>.</li>
        </ul>
        <p>
          <strong>Click a pill</strong> to show just that group (the header checkbox then selects all of
          it); <strong>hover a pill</strong> for a short explanation of what it means.
        </p>
        <p>
          A rejected duplicate&rsquo;s detail isn&rsquo;t wasted: when it unambiguously matched one existing
          transaction, <strong>Enrich</strong> folds its <em>novel</em> detail (a memo, a transaction id, a
          richer name) into that transaction&rsquo;s source record &mdash; additive and reversible
          (<strong>Unenrich</strong> removes exactly what was added). The file card&rsquo;s
          <strong> Enrich existing transactions from this source</strong> checkbox does the same for the
          whole file at once &mdash; at any time, since rejected rows keep their full detail &mdash; and a
          data source can opt in permanently on its mapping screen so future imports enrich automatically.
          Once a row has enriched its match, its Kind reads <strong>Matched</strong> (green) rather than
          &ldquo;Rejected&rdquo;: it was recognized as one you already had and contributed its detail, not
          discarded.
        </p>
        <p>
          Removing a duplicate never makes a row vanish silently &mdash; see{' '}
          <HelpLink to="/help/removed-as-duplicates">where a removed duplicate went</HelpLink>. If a single
          file lists the same purchase twice, that&rsquo;s a different problem &mdash; see{' '}
          <HelpLink to="/help/intra-file-duplicates">a source that double-lists rows</HelpLink>.
        </p>
      </>
    ),
  },
  {
    id: 'cross-account-duplicates',
    section: 'duplicates',
    title: 'Resolving a cross-account duplicate',
    surfaces: ['Duplicate-detection report'],
    summary: 'A Cross-account match means what appears to be the same transaction came in from different sources on different accounts. Options are: Keep both (they\'re two distinct transactions), Discard new, or Replace existing. Keep existing/Replace options related to what account the transaction is mapped to.',
    body: () => (
      <>
        <p>
          A <strong>cross-account match</strong> is what looks like the same transaction arriving from
          more than one source on <em>different accounts</em> &mdash; for example a charge seen once from
          a credit card and again from the bank account that pays it off. Because the accounts differ,
          the dedupe engine can&rsquo;t settle it on its own, so the report lists it as
          a <em>Review</em> item. There are three actions, and the right one depends on the outcome you
          want:
        </p>
        <p>
          Once the two accounts have been merged, the same pair is described as a <strong>possible
            duplicate in this account</strong> instead &mdash; the merge settled the account question, so
          the report stops calling it cross-account. The evidence and the three actions below are
          unchanged: a near-miss on text is not conclusive on its own, so such a pair stays in review
          rather than being removed automatically.
        </p>
        <ul>
          <li><strong>Keep both</strong> &mdash; they really are two different transactions. This also
            asserts <em>these two accounts are distinct</em>, so future imports stop re-flagging the pair.</li>
          <li><strong>Discard new</strong> &mdash; the just-imported row is the duplicate; keep the copy
            already in the ledger.</li>
          <li><strong>Replace existing</strong> &mdash; the just-imported row is the <em>better</em> record
            (e.g. it has the correct account). Keep it and remove the existing one. Use this when one source
            has the right account but another had the better categories.</li>
        </ul>
        <p>
          For Replace existing, the categorization comes from the new file if the new file is the only
          file with the box checked to import categories from the file. If both files, only the old file, or neither file,
          has that box checked, the category remains unchanged; it comes from the initial import.
        </p>
      </>
    ),
  },
  {
    id: 'merging-accounts',
    section: 'duplicates',
    title: 'Merging accounts to reconcile',
    surfaces: ['Accounts page'],
    summary: 'Merging two accounts that are truly the same physical account auto-confirms their overlapping duplicates; order doesn’t matter and detaching reverses it. Don’t merge an “umbrella” account that lumps several real cards under one label.',
    body: () => (
      <>
        <p>
          Merging two accounts on the Accounts page means <strong>“these are the same physical
            account.”</strong> When they genuinely are, merging <strong>auto-confirms the overlapping
              duplicates</strong> between them. The order is irrelevant: <em>importing then merging</em> and
          <em> merging then importing</em> reach the same state. <strong>Detaching</strong> an account later
          reverses the merge’s auto-confirmations &mdash; your explicit Reject / Replace decisions are kept.
        </p>
        <h4>The umbrella-account trap</h4>
        <p>
          Some sources record several real accounts under one generic label &mdash; e.g. an aggregator that
          files two physical cards as one account. <strong>Do not merge an umbrella account into a single
            card.</strong> Merging it into one card only resolves that card’s overlaps and strands the other’s.
        </p>
        <p>
          Instead, resolve the overlaps per row in the duplicate report &mdash;{' '}
          <HelpLink to="/help/cross-account-duplicates">Replace existing</HelpLink> keeps the
          correctly-accounted copy &mdash; or fix the accounts after import.
        </p>
      </>
    ),
  },
  {
    id: 'covered-range-review',
    section: 'duplicates',
    title: 'Reviewing covered-range duplicates (nearby date / transfer / no match)',
    surfaces: ['Duplicate-detection report'],
    summary: 'When an earlier import already covered a date range, every transaction in that range is expected to already be present, so each new row landing in it is paired against the existing data by date and amount (the exact date first, then ±1 day, then outward to a week, then a cross-account transfer twin). Three pairing outcomes are surfaced for review: Matched nearby date (a same-account counterpart turned up only after widening the window, and the row shows how many days apart), Possible transfer match (a same-amount row naming this account sits on another account — a wallet funding leg whose twin is already on your books), and No specific match (nothing paired at all, so the row may be genuinely missing from the earlier import).',
    body: () => (
      <>
        <p>
          When an earlier import already covered a date range, every transaction in that range is expected to
          already be in the ledger, so a newly-imported row landing inside it is rejected as a presumed
          duplicate and paired against the existing data by date and amount &mdash; the exact date first, then
          &plusmn;1 day, then outward a day at a time to a week, and finally a cross-account transfer twin.
          Three of the pairing outcomes are surfaced for review:
        </p>
        <ul>
          <li><strong>Matched nearby date</strong> &mdash; a counterpart turned up only after the date
            window widened past the exact day; each row states how far apart the two are. Posting dates drift
            between sources for several reasons &mdash; pending vs. posted timing, weekend or holiday
            settlement, and time-zone differences on foreign charges &mdash; so the same transaction can sit
            several days apart in two sources, and the further apart the pair sits the more it is worth a
            glance before clearing. Once the pair
            looks right, <strong>Mark reviewed</strong> (in bulk from the pill, or per row) clears it from the
            needs-attention list. If a pair turns out <em>not</em> to be the same transaction, select the rows
            and import both.</li>
          <li><strong>Possible transfer match</strong> &mdash; nothing matched on this account, but a
            same-amount transaction naming this account sits on <em>another</em> one, a few days apart. That
            is the signature of a wallet funding/deposit leg (a PayPal/Venmo &ldquo;Bank Deposit&rdquo; row)
            whose money-movement twin is the funding charge on your bank or card &mdash; already on your
            books, so the leg is correctly not re-imported. <strong>Mark reviewed</strong> to confirm, or
            <strong> Import anyway</strong> if they really are separate.</li>
          <li><strong>No specific match</strong> &mdash; the date is covered but nothing paired with it at
            all, anywhere in the window or across accounts. That makes it the row to actually investigate: it
            is usually present in one source and genuinely missing from the other, in which case
            <strong> Import anyway</strong> keeps it.</li>
        </ul>
        <p>
          A covered row that paired cleanly on the exact date or &plusmn;1 day stays rejected without being
          flagged &mdash; only the two cases above need a look.
        </p>
        <p>
          See also: <HelpLink to="/help/duplicate-report">reading the duplicate-detection report</HelpLink>.
        </p>
      </>
    ),
  },
  {
    id: 'amount-conventions',
    section: 'importing',
    title: 'How the file encodes debits and credits',
    surfaces: ['Import mapping', 'Data source editor'],
    summary: 'Tell the importer how the file represents money in vs out: a single signed column, a single amount column plus a separate debit/credit “type” column, or separate debit and credit columns.',
    body: () => (
      <>
        <p>
          Files express the direction of money in three common ways. Pick the <strong>amount
            convention</strong> that matches yours so debits and credits land with the right sign:
        </p>
        <ul>
          <li><strong>Single column: negative = debit.</strong> One signed amount column where outflows are
            negative.</li>
          <li><strong>Single column + a debit/credit type column.</strong> One unsigned amount column plus a
            separate column that says debit/credit (or deposit/withdrawal). Map both &mdash; the type column
            is what gives each amount its direction.</li>
          <li><strong>Two columns: separate debit / credit.</strong> Debits in one column, credits in
            another.</li>
        </ul>
        <p>
          {APP_NAME} tries to infer the convention from the file, but it’s worth confirming &mdash; an amount
          mapped with the wrong convention flips income and expense.
        </p>
        <p>
          <strong>Amounts are all in one currency, set on the Settings page.</strong> An amount is stored
          as a plain number with no currency recorded beside it, so two currencies kept together would be
          indistinguishable and both would join every total and budget. The setting says which one the
          numbers are in; it converts nothing, so changing it relabels existing amounts rather than
          restating them &mdash; which is why it asks for confirmation once transactions exist, and why
          changing it back undoes it just as cleanly. Where a connected data source reports that an
          account is held in a <em>different</em> currency, its transactions are <strong>not
            imported</strong> &mdash; the account mapping screen marks it, and syncs say so rather than
          leaving the account mysteriously empty. Skipping such an account keeps it out of the way.
        </p>
      </>
    ),
  },
  {
    id: 'unknown-data-source',
    section: 'importing',
    title: 'Data sources (saved mappings):',
    surfaces: ['Import / Export (Recent imports)'],
    summary: "Imported files not linked to a saved mapping are listed under “unknown data source” or “temporary draft”. A data source is a saved mapping which is useful if other files with the same format (eg. from the same source) will be imported later.",
    body: () => (
      <>
        <p>
          A <strong>data source</strong> is a saved template of the settings from the
          import mapping screen describing the fields and account mapping. Imported files
          are organized in the import history section by data source. If there will be future
          imports from the same data source it is useful to save the mapping so it does not
          need to be recreated each time. A file lands under <strong>unknown data source</strong> or a <strong>temporary
            draft</strong> when it isn’t linked a data source.
        </p>
        <p>Options include:</p>
        <ul>
          <li><strong>Assign to data source</strong> &mdash; pick an existing one.</li>
          <li><strong>+ New data source from this file</strong> &mdash; create a data source from this file’s
            own import mapping and link it.</li>
          <li><strong>Save as data source</strong> (temporary-draft card only) &mdash; build a new source from
            the draft snapshot’s column and account mapping.</li>
        </ul>
        <p>
          The <strong>Manage sources</strong> button can also be used to create new data sources
          (optionally using an existing file as a template) and to edit or delete existing
          data sources. Deleting a data source does not remove any files, just the mapping
          template.
        </p>
      </>
    ),
  },
  {
    id: 'imported-category-cleanup',
    section: 'importing',
    title: 'Set aside vs Delete vs Recover (imported categories)',
    surfaces: ['Group Imported Categories', 'Categories page'],
    summary: 'Set aside parks a pending imported label without deactivating it; Delete stops a category from coming back on future imports and moves it to Inactive, where Recover restores it. They are different tools - keep them straight.',
    body: () => (
      <>
        <p>
          The <strong>Group Imported Categories</strong> workspace is a landing spot for pending
          <em> imported</em> labels only. Two actions look similar but mean very different things:
        </p>
        <ul>
          <li><strong>Set aside</strong> is <em>parking</em>. It moves a label out of the “needs sorting”
            pool but leaves the category fully <strong>active</strong> &mdash; its transactions keep it and
            future imports of the label still categorize to it. Use this for “I’ve triaged this, leave it in
            Unassigned.” A set-aside category never appears in the Categories page <em>Inactive</em> list.</li>
          <li><strong>Delete</strong> is how you stop bringing a category in. It deactivates the category
            (existing transactions clear, or &mdash; via the Categories-page dialog &mdash; reassign to
            another category) while keeping their raw imported label, and <strong>future imports of that
              label come in uncategorized</strong> instead of recreating it.</li>
        </ul>
        <p>
          A deleted category moves to the <strong>Inactive</strong> list at the bottom of the Categories
          page, where <strong>Recover</strong> restores it as a permanent system category &mdash; back in the
          group it was deleted from, or <em>Unassigned</em> if that group is gone. A recovered (or any
          user-created) category does <strong>not</strong> reappear in the Group Imported Categories
          workspace; that workspace only ever holds pending imported labels.
        </p>
      </>
    ),
  },
  {
    id: 'amazon-import',
    section: 'importing',
    title: 'Importing Amazon order detail (AZAD Chrome extension)',
    surfaces: ['Import / Export — Amazon'],
    summary: 'Capture Amazon order detail using a Chrome browser extension to export order history. The item detail can be captured as well to provide categorization information if that is interesting. The existing Amazon charges are categorized as money movement to avoid double counting the charges.',
    body: () => (
      <>
        <p>
          Amazon purchases appear in the funding account as some form of <strong>AMAZON.COM</strong> and the amount with no hint
          of what was bought. The open-source <strong>AZAD</strong> (Amazon Order History Reporter) Chrome browser
          extension exports the Amazon order history as CSV files; {APP_NAME} reads the <strong>Orders</strong>{' '}
          file to create one transaction per order in an Amazon account, links
          it to the matching Amazon charge in the transaction ledger, and excludes it from totals so it is not
          counted twice.
        </p>
        <p><strong>Installation:</strong></p>
        <ul>
          <li>
            From a Chrome browser, open this page {' '}
            <a href="https://chromewebstore.google.com/detail/amazon-order-history-repo/mgkilgclilajckgnedgjgnfdokkgnibi" target="_blank" rel="noreferrer">Chrome Web Store</a>{' '}
            and install the extension in your browser. (details are on the{' '}
            <a href="https://github.com/philipmulcahy/azad" target="_blank" rel="noreferrer">AZAD project page</a>).
          </li><li>
            The default install is all that is needed &mdash; <em>preview / premium features</em> do not have to be
            enabled.
          </li><li>
            After you install it, the first time you browse to Amazon.com and log in, it will be running on the
            top of the page. Eventually it will finish and close. The tool is launched via the extension browser (or the tool icon if
            pinned to the toobar).
          </li>
        </ul>
        <p><strong>Export each year — the Orders file:</strong></p>
        <ol>
          <li>
            Sign in to Amazon, load the orders page and then open the AZAD extension.
            Check <strong>Show totals in csv downloads</strong>{' '}. If other fields are checked, their
            information will be captured as well.
          </li>
          <li>Select the <strong>Orders</strong> option and click the <strong>year</strong> you want.</li>
          <li>
            A tab may open with a Page Not Found error, something like <i>SORRY we couldn&apos;t find that page, Try searching or go to
              Amazon&apos;s home page</i>. Just close this tab. The results are on the prior tab where the order page had been opened.
          </li>
          <li>
            When the table finishes loading, change <strong>Show 10 entries</strong> to <strong>All</strong>,
            then click <strong>download spreadsheet (&apos;.csv&apos;)</strong>.
          </li>
          <li>
            <em>Optional:</em> The AZAD extension can export both order data and item data.
            The <strong>Orders file</strong> provides transaction-level financial totals and
            the <strong>Items file</strong> adds the following additional detail:
            <p>
              <ul>
                <li><strong>Line-Item Granularity:</strong> Expands multi-item purchases into individual rows so products can be analyzed independently.</li>
                <li><strong>Product Identifiers:</strong> The <strong>ASIN</strong> (Amazon Standard Identification Number) and direct <strong>Item URLs</strong>.</li>
                <li><strong>Unit Pricing &amp; Quantities:</strong> Shows individual item prices (pre-tax/shipping) and item quantities rather than order totals.</li>
                <li><strong>Subscription Status:</strong> Includes a <strong>Subscribe &amp; Save</strong> flag for recurring purchases.</li>
                <li><strong>Categorization:</strong> Includes a <strong>Category</strong> field for item classification.</li>
              </ul>
            </p>
            If this additional information is desired (the per-item pricing can be especially useful) select the <strong>Items</strong> report
            and run the export again for the same year. Select all rows and save it under a
            different name. Import both files.
          </li>
          <li>Repeat for each year you want to bring in.</li>
        </ol>
        <p>
          Drop the files on the CSV importer or click on the CSV importer to browse to the files to load. It does not
          matter whether it is the csv importer on the <strong>Import</strong> tab or on the <strong>Amazon</strong> tab.
          Provide any number of years at one time. The items and orders files are
          recognized by their columns and the files are recognized by the date ranges so
          upload order and file names do not matter. The tab then shows a
          <strong> mapping screen</strong> (like the CSV importer): pick the <strong>account</strong> to import
          into, confirm the <strong>category</strong> used for categorizing the the matched card charges, and map each
          new <strong>payment card</strong> from the import to a payment account. <strong>Import</strong> lights up once every card has an account
          (or is marked <em>Untracked</em>). An <strong>Items</strong> file adds its detail to the matching
          orders you have imported; if its Orders file isn&apos;t in yet, that detail is set aside and
          attaches automatically when you later import the Orders file &mdash; no need to re-import the Items
          file. Afterwards you only need to export the
          <strong> current year</strong> now and then to pull in recent purchases.
        </p>
        <p>
          Periodically run the export again for the current year and import the result to bring in information
          for recent purchases.
        </p>
        <p>
          Re-importing is always safe: files are recognized by <em>content</em>. Orders are keyed using their Amazon
          order id, so overlapping exports are handled correctly.
        </p>
      </>
    ),
  },
  {
    id: 'amazon-funding-sources',
    section: 'importing',
    title: 'Amazon settings (funding sources + category)',
    surfaces: ['Import / Export — Amazon'],
    summary: `Two global Amazon settings: which of your accounts each payment card charges (so the matching charge is found and excluded), and which category that excluded charge goes into. Set once, applied to every Amazon import.`,
    body: () => (
      <>
        <p>
          <strong>Funding sources.</strong> Every Amazon order names the card that paid for it (a network and
          the last four digits, e.g. <em>Fablecard ···4455</em>), but that isn’t enough on its own to know
          which of <em>your</em> accounts the charge landed on &mdash; imported statements usually don’t carry
          the card number. A funding source makes that link: you map each Amazon payment card to the account
          it charges, and {APP_NAME} constrains its search for the matching <strong>AMAZON.COM</strong> charge
          to that account, so the charge is found, linked, and excluded from totals exactly once.
        </p>
        <p>
          The map is <strong>global</strong> &mdash; map a card once and it applies to every Amazon account
          you import for. Each card can be:
        </p>
        <ul>
          <li><strong>Mapped to an account</strong> &mdash; the normal case; the charge is matched and excluded.</li>
          <li>
            <strong>Untracked</strong> &mdash; a card that isn’t one of your accounts (a spouse’s card, a
            one-off). Its orders are still recorded and counted, since there’s no charge of yours to exclude.
          </li>
        </ul>
        <p>
          You set these on the <strong>mapping screen</strong> that appears after you drop your files, in the
          <strong> Payment cards in these files</strong> section &mdash; each card the files use is listed, with
          its account filled in if you&apos;ve mapped it before, or <strong>Needs mapping</strong> if it&apos;s
          new. Import stays disabled until every card has an account (or is marked Untracked). Because you map
          before importing, the charges are matched on that same import &mdash; there is never any need to
          import a file twice.
        </p>
        <p>
          <strong>Category for the excluded charge.</strong> When the card charge is matched, it’s moved into
          an excluded category so your Amazon spending (the order transactions) counts once and the raw card
          charge doesn’t double it. Pick or create the category to use &mdash; it’s global, and a change
          applies to <em>future</em> imports only (already-imported charges keep their category). Choose an
          excluded category (like one under <em>Transfers</em>); {APP_NAME} warns if the one you pick isn’t
          excluded, since that would count Amazon spend twice.
        </p>
      </>
    ),
  },
  {
    id: 'amazon-reconciliation',
    section: 'importing',
    title: 'Amazon reconciliation report',
    surfaces: ['Import / Export — Amazon', 'Import history (transactions ↗ pill)'],
    summary: 'After an Amazon import, a floating report shows how the orders line up with the card charges in your ledger — matched, duplicate charges to merge or discard, split-shipment matches to confirm, orders with no charge, and Amazon charges no order accounts for.',
    body: () => (
      <>
        <p>
          When you import Amazon orders, {APP_NAME} pairs each order with the card charge that paid for it and
          excludes that charge so the money counts once. The <strong>reconciliation report</strong> shows how
          that went &mdash; open it from <strong>View reconciliation report →</strong> after an import, or from
          the file’s <strong>transactions ↗</strong> pill in the import history. It floats free of the page
          (drag, resize, or <strong>Minimize</strong> it to the nav bar), so you can go inspect transactions
          and come back. Rows group into:
        </p>
        <ul>
          <li><strong>Duplicate detected</strong> &mdash; two or more identical charges made the order ambiguous,
            usually the same charge imported twice (e.g. two Mint syncs). <strong>Merge → keep one</strong> keeps
            the richest copy (folding in any detail the others carried), trashes the rest, and matches the order;
            <strong> Not duplicates</strong> marks the copies as distinct purchases instead (never re-flagged; the
            order falls back to the unmatched path, and a copy dated on the order itself is re-suggested for
            review). When other unmatched orders share the amount, Merge isn’t offered &mdash; use Not duplicates,
            or the per-copy <strong>Discard</strong> for a copy you know is a double import.</li>
          <li><strong>Duplicate · review</strong> &mdash; same-amount copies that only turn up <em>outside</em> the
            strict &plusmn;3-day match window (within two weeks). Likely still a double import, but the dates
            don’t corroborate it &mdash; so examine each copy (hover for its origin detail), then resolve with
            the same Merge / Discard / <strong>Not duplicates</strong> &mdash; per row, or bulk-Merge the rows
            you&rsquo;ve checked (a merged-away copy is restorable from Settings → Trash).</li>
          <li><strong>No charge found</strong> &mdash; counted, but no charge was matched to exclude (an untracked
            card, history that predates your imports, an order whose export named no card and whose charge
            doesn&rsquo;t read as Amazon, or a miss). <strong>Link charges…</strong> opens a picker
            over the unaccounted charges with a running sum against the order total &mdash; check the charge(s)
            that paid for it (several, if the order was split) and link them. A mismatched sum warns but doesn’t
            block. These orders count toward the import&rsquo;s needs-attention total so a stray one gets a look;
            when there&rsquo;s genuinely nothing to link (an untracked card), <strong>Mark reviewed</strong>
            acknowledges it &mdash; it stays listed here but drops out of the attention count so it won&rsquo;t
            keep nagging (Undo puts it back). Works per row or on a bulk selection.</li>
          <li><strong>Matched · review</strong> &mdash; no single charge equals the order total, but a unique set
            of unaccounted charges sums to it: Amazon billed the order per shipment. <strong>Accept</strong> links
            the whole set; <strong>Dismiss</strong> if it’s not a match (it won’t be re-suggested). A set spanning
            more than a week is flagged so you can eyeball it first. A <em>single</em>-charge suggestion carries a
            note naming why it didn’t match automatically &mdash; outside the ±3-day window, a cent off the
            total, or imported after the order was.</li>
          <li><strong>Unaccounted · duplicate</strong> &mdash; unaccounted charges that look like <em>copies of each
            other</em> (same account and amount, days apart) with no order for either &mdash; the double import the
            general dedupe can’t catch. <strong>Merge → keep one</strong> keeps the richest copy (which returns to
            the unaccounted list); <strong>Discard</strong> a copy; or <strong>Not duplicates</strong> if they’re
            distinct purchases &mdash; the group won’t be flagged again. Merge works per row or in bulk on
            selected rows.
            A merged-away or discarded copy is recoverable from Settings → Trash’s <em>Duplicate
              transactions</em> section, grouped by the file it came from.</li>
          <li><strong>Unaccounted charge</strong> &mdash; ledger charges that look like Amazon, on the cards Amazon
            uses, in this import’s date range, that no order accounts for. Best-effort, but surfaced for a look:
            these count toward the import&rsquo;s needs-attention total so a stray one (say, a duplicate the
            report couldn&rsquo;t pair) gets noticed. <strong>Trash</strong> sends one to Trash &mdash; the escape
            hatch for that unpaired duplicate. It acts on the whole row, so it also works in bulk
            (<strong>Move to trash</strong>); the per-copy <strong>Discard</strong> on a stacked duplicate row
            names one copy instead, which is why only Trash has a bulk form. They also file differently: Discard
            is a dedupe resolution and lands under Settings → Trash&rsquo;s <em>Duplicate transactions</em>,
            while Trash is an ordinary delete and lands under <em>Transactions</em>. When a charge is just a
            purchase the export didn&rsquo;t cover (nothing to fix), <strong>Mark reviewed</strong> acknowledges
            it so it drops out of the attention count without trashing it (Undo puts it back) &mdash; per row or
            on a bulk selection.</li>
          <li><strong>Matched</strong> &mdash; the order and the charge(s) it excluded. If a pairing is wrong
            (a coincidental same-amount charge, or a suggestion you accepted that turned out not to be this
            order&rsquo;s), <strong>Unlink</strong> detaches the charge &mdash; its original category is
            restored and the order returns to <em>No charge found</em>, where <strong>Link charges…</strong>
            can pair it correctly.</li>
        </ul>
        <p>
          Hover any order or charge for its <strong>origin detail</strong> (source file, captured fields,
          imported category), and use the <strong>↗</strong> beside an order to open that order&rsquo;s own
          page on Amazon &mdash; often the only place a thin digital order&rsquo;s detail exists. (The link is
          captured at import, so it appears on orders imported from now on.)
        </p>
        <p>
          For batch cleanup, filter with the pills, tick the row checkboxes (or the select-all header), and the
          bulk bar applies <strong>Merge / Accept / Dismiss / Unlink / Move to trash</strong> to every selected
          row that supports it. Rows of different kinds accept different actions, so each button carries the
          number of your selection it applies to &mdash; a selection can be mixed, and each action reaches
          only its own rows.
          Items needing action also show as an <strong>N to resolve</strong> warning on the file card and a task
          on the Tasks page; both clear as you resolve them. Everything the import itself did reverses if you
          undo it; duplicate copies you merged or discarded are restorable from Settings → Trash instead.
        </p>
      </>
    ),
  },
  {
    id: 'amazon-import-detail',
    section: 'importing',
    title: 'Amazon import detail report',
    surfaces: ['Import history — outcome pills (orders / items matched / no match / …)'],
    summary: 'The outcome pills on an Amazon file card open a report of what that import actually did — the orders it created, items matched into orders, items with no matching order yet, duplicates, and payments — each row showing which file it came from.',
    body: () => (
      <>
        <p>
          Each Amazon file card carries outcome pills &mdash; <strong>orders</strong>, <strong>items
            matched</strong>, <strong>already enriched</strong>, <strong>no match</strong>,{' '}
          <strong>duplicates</strong>, <strong>payments</strong> &mdash; and clicking one opens the{' '}
          <strong>import detail report</strong> on that view. Every row shows the <strong>source file</strong> it
          came from, which is what makes file mix-ups diagnosable:
        </p>
        <ul>
          <li><strong>No match</strong> items had no order to attach to &mdash; usually the items file was
            imported before its orders file. Their detail is <em>saved</em>, not lost: importing the matching
            orders file later attaches it automatically (no need to re-import the items file), and the pill flips
            to <strong>attached to orders</strong> once that happens.</li>
          <li><strong>Duplicates</strong> are orders a previous import already brought in &mdash; the file added
            nothing new. <strong>Already enriched</strong> is the items-file flavor of the same thing.</li>
          <li><strong>Payments</strong> tallies the matched card charges by the account they landed on.</li>
        </ul>
        <p>
          Files are recognized by <em>content</em>, not name: re-uploading a file a completed import already took
          is skipped with an “already imported” notice (no second file card), and undoing an import frees its
          files to import again.
        </p>
      </>
    ),
  },
  {
    id: 'intra-file-duplicates',
    section: 'duplicates',
    title: 'A source that lists the same row twice',
    surfaces: ['Import / Export (duplicate report)'],
    summary: 'Duplicate detection compares an incoming file against what is already in the ledger, so two copies inside one file both import and neither is flagged -- deliberately, because a real repeat purchase and an export artifact look identical. The fix is to clean the export before importing it, or to trash the extra copy after.',
    body: () => (
      <>
        <p>
          Some exports list the same purchase twice, often a day apart. This is different from every other
          duplicate case, and it is worth knowing why nothing catches it.
        </p>
        <p>
          Duplicate detection compares an <em>incoming file</em> against what is already in the ledger. Two
          copies of one purchase sitting inside the same file have nothing to be compared against, so both
          import and neither is flagged. That is deliberate rather than an oversight: a genuine repeat
          purchase -- the same coffee at the same price on two mornings -- and an export artifact are the
          same rows. Guessing between them would either drop real transactions or leave false flags to
          clear on every import, and only the person who knows the merchant can tell which is which.
        </p>

        <h4>Spotting it</h4>
        <p>
          Sorting the imported file&rsquo;s rows by amount brings identical figures together, which is the
          quickest way to see whether a file is doing this. It tends to be a property of the
          <em>source</em> rather than of one export -- if one file from a source double-lists, later ones
          usually will too, so it is worth checking the first import from any new source.
        </p>

        <h4>Two ways to deal with it</h4>
        <ul>
          <li>
            <strong>Clean the file before importing.</strong> The better fix where a source does this
            every time. Work on a copy, keep a record of what was dropped, and be generous about what
            counts as a duplicate -- rows a day or two apart with the same amount and merchant. Small
            fixed-price repeats (a vending machine, a parking meter) are acceptable casualties; they do
            not move a total.
          </li>
          <li>
            <strong>Trash the extra copy after importing.</strong> Fine for a one-off. Find the pair on
            the Transactions page, select the copy to remove, and move it to trash -- it stays recoverable
            from Settings until the trash is emptied.
          </li>
        </ul>
        <p>
          Undoing the whole import and starting again from a cleaned file is always available too, and is
          usually less work than picking through a long history by hand.
        </p>
      </>
    ),
  },
  {
    id: 'removed-as-duplicates',
    section: 'duplicates',
    title: 'Where a removed duplicate went',
    surfaces: ['File ledger (↗)'],
    summary: 'A Replace or merge that removes a duplicate doesn’t make the row vanish without a trace -- a file’s ledger has a collapsible “Removed as duplicates” list showing each removed row and which account the kept copy lives on.',
    body: () => (
      <>
        <p>
          When a <HelpLink to="/help/cross-account-duplicates">Replace</HelpLink> or a{' '}
          <HelpLink to="/help/merging-accounts">merge</HelpLink> removes a duplicate, the row isn’t gone
          without a trace. Open a file’s ledger (the <strong>↗</strong>) and expand the collapsible
          <strong> Removed as duplicates</strong> list: it shows each removed row and which account the kept
          copy now lives on. So a Replace or merge done from another file never makes a transaction
          mysteriously disappear. Duplicate charge copies merged away on the <em>Amazon reconciliation
            report</em> land here too &mdash; for those the kept copy is usually on the <em>same</em> account (a
          doubled import of one charge), and the removed copy is restorable from Settings → Trash.
        </p>
      </>
    ),
  },
  {
    id: 'searching-transactions',
    section: 'reports',
    title: 'Searching by date or amount',
    surfaces: ['Transactions search', 'File ledger search'],
    summary: 'The file-ledger and Transactions search boxes match dates and amounts, in addition to merchant names, categories and accounts -- type a year, month, day, or a dollar amount to find the matching transaction(s)',
    body: () => (
      <>
        <p>
          The file-ledger and Transactions search boxes accept more than text. To find a
          transaction in a long ledger, type any of:
        </p>
        <ul>
          <li>a <strong>year</strong> &mdash; <code>2023</code></li>
          <li>a <strong>month in a year</strong> &mdash; <code>03/2023</code></li>
          <li>a <strong>day</strong> &mdash; <code>03/15/2023</code></li>
          <li>a <strong>month</strong> or <strong>month/day</strong> with no year &mdash; <code>03</code> or <code>03/15</code> &mdash; matches that date in every year</li>
          <li>an <strong>amount</strong> &mdash; <code>68</code></li>
        </ul>
        <p>and the list jumps to matching rows.</p>
      </>
    ),
  },
  {
    id: 'reviewing-transactions',
    section: 'importing',
    title: 'Reviewing newly imported transactions',
    surfaces: ['Transactions (Needs review)', 'Import / Export (file card)'],
    summary: 'New transactions arrive flagged needs review so they can be looked over before being trusted. The R marker, the Needs review filter, and Mark reviewed work through them. A whole imported file clears at once with Mark all reviewed.',
    body: () => (
      <>
        <p>
          New transactions usually come in batches -- a CSV, a series of CSV files, or a data connection.
          Some get categorized automatically by rules along the way. It is worth looking over new transactions
          before trusting them, to catch any mistakes. Sometimes a transaction that matched a rule is
          an exception that belongs in a different category. As an aid, new transactions
          start out flagged <strong>needs review</strong>, with a small <strong>R</strong> marker in its row.
        </p>
        <p>
          The flag is separate from whether a transaction is categorized. A rule-categorized transaction can
          still be worth a look. A reviewed transaction can be left uncategorized on purpose. So <strong>needs
            review</strong> and <strong>uncategorized</strong> are two different filters.
        </p>
        <p>The flag clears two ways:</p>
        <ul>
          <li>Editing the transaction’s category clears it. Correcting the category counts as reviewing it.</li>
          <li>
            <strong>Mark reviewed</strong> clears it without changing anything else. That covers the common
            case where the category is already right and the transaction just needed a glance. It is on the
            row’s right-click menu and in the bulk-edit bar, so a whole selection can be cleared at once.
          </li>
        </ul>
        <p>
          There is a <strong>Needs review</strong> filter on the Transactions page.
        </p>
        <p>
          A long historical import flags a lot of transactions at once. If reviewing them is not of interest,
          each imported file’s card on the Import / Export page shows a <strong>to
            review</strong> count and a <strong>Mark all reviewed</strong> button that clears the whole file in
          one click. A data connection has corresponding per-file card yet. Its transactions are cleared with
          the <strong>Needs review</strong> filter and a bulk <strong>Mark reviewed</strong> instead.
        </p>
      </>
    ),
  },
  {
    id: 'generate-rules',
    section: 'importing',
    title: 'Generating rules from transactions in an imported file',
    surfaces: ['Import / Export (rule suggestions)'],
    summary: 'Generate rules studies a file whose transactions are already categorized and proposes rules that reproduce that categorization on future data -- the output is rules, not a re-categorization of the file. When one merchant was filed under several categories the suggestions form a conflict set, which can be resolved in different ways for different results.',
    body: () => (
      <>
        <p>
          If the data comes from another tool where the transactions already carry meaningful categories, tell
          {APP_NAME} the import’s data is category data is useful (turn on <em>“use the categories present in the data”</em>
          on the file’s card). {APP_NAME} keeps those categories on the imported rows, adds any which are missing to
          the system’s list of categories, and <strong>Generate rules</strong> analyzes them to propose rules that reproduce the
          same categorization on future, uncategorized data. Nothing takes effect until it has been
          reviewed.
        </p>
        <p>
          The <strong>output of Generate rules is rules</strong>, not a
          re-categorization of the file. The imported rows are already categorized -- that is the
          input; the goal is to capture the <em>pattern</em> so future imports categorize themselves.
          That said, two things on this screen do still change the underlying rows.
          <ol type="a">
            <li>
              Accepting a suggestion applies its rule to exactly the rows that generated it. The
              category value usually does not move (the rule came from those rows), but it hands them
              from the file’s categorization to the rule’s -- so an edit made to the rule first (a
              tweaked category, added tags, a rename) lands on those rows too, and they shift from
              import-locked to rule-governed (see{' '}
              <HelpLink to="/help/re-categorizing">what changes a transaction’s category</HelpLink>).
            </li>
            <li>
              Resolving a conflict has various options to re-categorize rows.
            </li>
          </ol>
        </p>
        <p>Available actions for each suggested rule:</p>
        <ul>
          <li><strong>Save</strong> it (optionally after editing its keyword, category, owner/account
            scope, amount range, rename, or tags),</li>
          <li><strong>Defer</strong> it to decide later, or</li>
          <li><strong>Discard</strong> -- reject the proposed rule. The two buttons under
            <em>discard and&hellip;</em> choose what happens to the rows it covered:
            <em>keep categorization</em> leaves them exactly as imported -- the file&rsquo;s category
            sticks as a settled decision, stays trusted-import, and is still reclaimable later if a
            matching rule is created and applied; <em>remove categorization</em> clears the category
            instead, freeing the rows for rules to categorize later (the discarded file label is kept on
            the row but is never re-applied). Keep is the choice for a genuine exception (an annual fee
            filed under its own category); remove is for a file category that was wrong or messy.</li>
        </ul>
        <h4>Conflict sets, and the different ways to resolve them</h4>
        <p>
          When the same merchant was filed under <strong>several different categories</strong>, a single
          keyword cannot reproduce all of them, so those suggestions are grouped into
          a <strong>conflict set</strong>. Open the set to see the competing categories and the matching
          rows. The resolution chosen determines the result:
        </p>
        <ul>
          <li><strong>Narrow the rules so they no longer overlap.</strong> Add a distinguishing filter
            (owner, account, or amount) to each rule so each claims its own subset, keeping more than
            one rule for the merchant.</li>
          <li><strong>Pick one category for the merchant and re-categorize the rest.</strong> The
            matching-transactions viewer can set the majority category in bulk to collapse the conflict
            to a single rule. Re-categorizing here <em>corrects the file’s category</em>, and the rows
            keep their trusted-import weight, so they keep informing the suggestions.</li>
          <li><strong>Keep an outlier as a one-off.</strong> <strong>Preserve</strong> a genuinely
            distinct row to record it as a manual exception: rules leave it alone and it drops out of
            the suggestions entirely, rather than re-surfacing as a conflict.</li>
        </ul>
        <p>
          The distinction between the last two is what produces different results: a bulk re-categorize
          keeps rows in the trusted-import learning set and re-targets the rule, while Preserve carves a
          row out as an untouchable manual decision. How those weights behave afterward is covered
          in <HelpLink to="/help/re-categorizing">what changes a transaction’s category</HelpLink>.
        </p>
        <h4>Older suggestions, and clearing them out in bulk</h4>
        <p>
          Rules are forward-looking, so a merchant pattern with no recent activity is unlikely to recur.
          Suggestions whose newest matching transaction falls outside the <em>Look back</em> window move
          off the main <em>pending</em> list onto a separate <em>older</em> pill, so the pending count
          reflects only patterns that are still live. Nothing is lost -- widening the look-back window
          brings them back, and the underlying rows are untouched by the lens itself.
        </p>
        <p>
          Because older suggestions are already out of the way, settling them is optional -- a stale tail
          can simply be left alone. When tidying is wanted, open the <em>older</em> pill, select several
          rows at once, and apply a bulk disposition: <em>Discard, keep categories</em> marks them
          reviewed while leaving their rows exactly as imported (the honest default for a pattern not
          worth a rule), or <em>Discard, clear categories</em> additionally clears those rows so future
          rules may categorize them. Either choice changes each row&rsquo;s import state the same way the
          single-suggestion Discard does above.
        </p>
        <p>
          See also:{' '}
          <HelpLink to="/help/parts-of-luma">how rules come into being</HelpLink>.
        </p>
      </>
    ),
  },
  {
    id: 'transaction-documents',
    section: 'transaction-detail',
    title: 'Attaching receipts and invoices',
    surfaces: ['Transactions (row marker)', 'Transaction detail (Documents)'],
    summary: 'A transaction records that money moved, not what was bought. Receipts and invoices attach to the transaction they belong to -- dropped, browsed, or pasted straight out of an email -- and text inside a PDF or a paste is searchable from the ordinary filter box.',
    body: () => (
      <>
        <p>
          A transaction records that money moved and where it went. It does not record <em>what was
            bought</em>. For most rows that does not matter. For a car repair, a service invoice, or a
          purchase with a warranty behind it, the useful detail exists only on paperwork
          that {APP_NAME} has never seen -- so it can be attached to the transaction it belongs to.
        </p>
        <p>
          Attachments live on the transaction detail panel under <strong>Documents</strong>, and a row
          that carries any shows a paperclip marker which opens them. One transaction can hold several:
          a repair often arrives as an estimate and then a final invoice, and a two-page bill
          photographs as two files.
        </p>

        <h4>Four ways to attach one</h4>
        <p>All four end in the same place, so whichever is nearest is the right one.</p>
        <ul>
          <li><strong>Drop a file</strong> onto the panel, or click it to browse.</li>
          <li>
            <strong>Paste an image</strong> -- a screenshot, or a photo already on the clipboard. There is
            nothing to review, so it attaches straight away.
          </li>
          <li>
            <strong>Paste text</strong> into the box below. A receipt that arrived by email is usually
            copied out of the mail client rather than saved first, and pasted text lands in the box where
            a signature or a quoted reply can be trimmed off before it is attached.
          </li>
          <li>
            <strong>A saved email</strong> (an <code>.eml</code> file) can be dropped like any other file.
            The message itself is not what gets stored -- the receipt inside it is, named by the subject
            line, which is usually the only recognizable thing about an exported message.
          </li>
        </ul>
        <p>
          An unedited paste keeps the layout it came with. The plain-text flavour of a copied email is its
          table flattened, one cell to a line, so an amount ends up under the item it prices rather than
          beside it; keeping the original markup preserves the arrangement the sender laid out. Editing
          the box turns that off, since an edit says the text on screen is what was wanted. The panel
          states which of the two will be stored.
        </p>

        <h4>What is accepted, and what happens to it</h4>
        <p>
          PDFs, images, plain text, and saved email. A PDF is kept exactly as it arrived, because its text
          layer is what makes it the best thing to attach. A large photograph is scaled down once on the
          way in -- a receipt shot at twelve megapixels carries nothing legible above roughly 300 DPI at
          text size -- and the original is not kept. Screenshots and small images pass through untouched,
          since crisp text is what re-encoding treats worst. A generous per-file size limit exists to stop
          a pathological scan, not to ration space.
        </p>
        <p>
          Attaching the same file to the same transaction twice is reported rather than stored twice.
          Dropping a receipt again because nothing visibly happened quickly enough is ordinary behaviour,
          and two identical entries would then have to be told apart by nothing.
        </p>

        <h4>Searching what is inside</h4>
        <p>
          Text found in an attachment is searched by the ordinary quick-filter box on the Transactions
          page -- no prefix required. A transaction whose match came from an attachment is marked, so a
          row returned for a term that appears in none of its visible fields still explains itself.
          Typing <code>doc:</code> before the terms narrows a search to attachments only. See{' '}
          <HelpLink to="/help/searching-transactions">searching by date or amount</HelpLink> for the rest
          of that box.
        </p>
        <p>
          Text is available for a PDF carrying a text layer, and for anything pasted as text. A
          <em>photograph</em> of a receipt has no text to extract -- reading text out of a picture is not
          built -- so a photographed receipt is stored and viewable, but not findable by what it says.
        </p>

        <h4>Removing, the trash, and backups</h4>
        <p>
          Removing a document deletes the file and cannot be undone, so it asks first. That is different
          from trashing the <em>transaction</em>: documents follow their transaction into the trash, come
          back intact if it is restored, and are destroyed only when the trash is emptied.
        </p>
        <p>
          Attached files are stored beside the ledger on disk rather than inside the database, and they
          travel inside the <strong>Financial data</strong> backup along with the transactions that
          reference them -- so a backup taken after attaching a receipt contains the receipt. See{' '}
          <HelpLink to="/help/data-and-backups">data on disk, and backups</HelpLink>.
        </p>
      </>
    ),
  },
  {
    id: 'multi-payment-purchases',
    section: 'transaction-detail',
    title: 'One purchase paid in several payments',
    surfaces: ['Transactions (link marker, Bulk Edit)', 'Transaction detail (Purchase)'],
    summary: 'A deposit and a final payment are two real transactions for one purchase. Linking them records that, and gives the purchase a total, without changing anything about the transactions or about any report. Select the payments under Bulk Edit and choose Link as one purchase.',
    body: () => (
      <>
        <p>
          Some purchases are paid in more than one go -- a deposit up front and the balance on completion,
          or a few instalments. Each payment is a real movement of money on its own date, and each is
          recorded correctly. What the ledger cannot say on its own is that they add up to one thing,
          which leaves a deposit reading as a mysterious partial amount and leaves &ldquo;what did that
          actually cost&rdquo; to memory.
        </p>
        <p>
          Linking the payments as a <strong>purchase</strong> records that relationship.
          <strong> Nothing about the transactions changes</strong> -- categories, amounts, dates, and
          every total and chart stay exactly as they were. A purchase says which rows belong together;
          it does not restate them.
        </p>

        <h4>Grouping the payments</h4>
        <p>
          On the Transactions page, turn on <strong>Bulk Edit</strong>, tick the payments that make up the
          purchase, and choose <strong>Link as one purchase</strong>. The dialog lists what is about to be
          grouped, with a running total, so a row ticked by mistake is visible before anything is saved.
        </p>
        <p>
          A name is optional, and is pre-filled from the payee when every payment shares one. Two further
          fields are worth filling in when the paperwork is to hand: the <strong>invoice or order
            number</strong>, and the <strong>expected total</strong> -- what the purchase was supposed to
          come to.
        </p>

        <h4>Reading it back</h4>
        <p>
          Each grouped payment carries a small <strong>&#128279;</strong> marker in its row. Hovering it
          says which payment of how many this is, what the purchase is called, and how much has been
          linked against what was expected. Clicking it opens the purchase. The transaction detail panel
          shows the same summary under <strong>Purchase</strong>, and opens the same editor.
        </p>
        <p>
          Where an expected total was recorded, the difference from it shows
          as <strong>Unaccounted</strong>. That word is deliberate: a gap may be a payment that has not
          been made yet, or one that has been made and not yet linked, and nothing in the ledger can tell
          those apart. When the payments account for the total exactly, it says so instead.
        </p>

        <h4>Changing one afterwards</h4>
        <ul>
          <li>
            <strong>A payment that turns up later</strong> joins the existing purchase rather than
            starting a second one: tick it together with any payment already in that purchase, and the
            same action adds it.
          </li>
          <li>
            <strong>A payment linked by mistake</strong> comes out from the purchase itself, with
            the <strong>&times;</strong> beside it. The transaction is untouched -- it simply stops
            counting toward the purchase. Removing one that would leave a single payment behind ungroups
            the purchase entirely, and says so before doing it.
          </li>
          <li>
            <strong>Ungroup</strong> undoes the grouping altogether. Every payment stays exactly as it is,
            and the same payments can be linked again afterwards.
          </li>
        </ul>

        <h4>What belongs in one, and what does not</h4>
        <p>
          A refund against the purchase can be linked as well, and the total then reads as the net --
          which is what the purchase actually cost. A payment that has been trashed stops counting toward
          the total but stays listed, struck through, so nothing vanishes from a purchase without saying
          why.
        </p>
        <p>
          A payment belongs to <em>one</em> purchase. Where a single payment covered two separate
          purchases, splitting that transaction across categories is the tool for it -- linking it to both
          would count the whole payment toward each.
        </p>
        <p>
          This is for a purchase that ends: a deposit and a balance, three instalments on a piece of
          furniture. Something that repeats indefinitely -- a subscription, a monthly bill, a mortgage --
          is a <HelpLink to="/help/recurring-transactions">recurring series</HelpLink> instead, which
          tracks a cadence and what is due next.
        </p>
      </>
    ),
  },
  {
    id: 'recurring-transactions',
    section: 'recurring',
    title: 'Recurring transactions',
    surfaces: ['Recurring', 'Rules (recurring series)', 'Transactions (row menu)'],
    summary: 'A recurring series tracks a transaction that repeats on a schedule. Many are found automatically by looking for similar looking transactions on a fixed schedule.Recurring transactions the scan misses can be identified by creating a Rule. Per-transaction overrides exist for the exceptions. A review section reports what is missing, what changed price, and what was just detected, alongside a forward view of what is due next.',
    body: () => (
      <>
        <p>
          A <strong>recurring series</strong> is a transaction that repeats on a schedule -- a subscription, a
          bill, a paycheck. {APP_NAME} keeps each one as its own record, so it can track the cadence,
          the usual amount, and when the next occurrence is due.
        </p>

        <h4>Found automatically</h4>
        <p>
          A <strong>scan</strong> looks across recent history for transactions which arrive on a regular rhythm.
          The signal is <em>regularity of timing</em>, not frequency. A punctual once-a-year tax is
          recognized; a busy merchant paid at random is not. The scan runs on
          its own after an import, and can be run on demand from the Recurring page.
        </p>
        <p>
          Amount is a hint, not a gate. A utility bill that changes every month still qualifies, because
          it arrives on a schedule. Transactions are grouped by payee <em>and</em> category, so one biller
          with several obligations -- a town charging property tax quarterly and water monthly -- becomes
          individual series rather than one muddled one.
        </p>
        <p>
          A newly found series is a <strong>suggestion</strong> for review. Confirm the ones that are correct; mark the
          rest <em>not recurring</em> and they will not be proposed again.
        </p>

        <h4>When the scan cannot see it</h4>
        <p>
          The scan groups by the payee name on the statement. Sometimes merchant names come in with different
          variations and the scan cannot determine that it is a single payee. While it is useful for reporting
          to create rules that generate a single name for a payee, rules can also indicate that the
          matching transactions for a series. Turn on this flag and every transaction the rule matches
          becomes a member of one series. A rule matches by keyword -- with optional amount and scope -- so
          it gathers all the spellings at once, and later transactions attach themselves as they arrive. To
          change which transactions belong, edit the rule. It is unusual but if all of the transactions
          for a series cannot be captured by a single rule, having multiple rules to generate a single
          merchant name will surface the series.
        </p>
        <p>
          A one-off that does not warrant a rule can still be added by hand from the Recurring page.
        </p>

        <h4>Which transactions belong</h4>
        <p>
          Membership is <strong>recomputed on every scan</strong>: it is a cache of what currently matches,
          not a hand-kept list. Two per-transaction corrections outlast that rebuild.
        </p>
        <ul>
          <li>
            <strong>Remove from the series</strong> -- for a transaction the scan swept in by mistake. It stays
            out across future scans. A removal is reversible: undo it from the prompt, from the removed
            transaction’s own right-click menu (<em>Restore to recurring series</em>), or from
            the <em>removed</em> list inside the series.
          </li>
        </ul>
        <p>
          There is no way to force a transaction into a series it does not match, on purpose. A series is
          defined by what recurs, so a charge that merely shares a payee and category with one -- a late
          fee on a tax payment, say -- is not part of it, and forcing it in would distort the series and
          the totals read from it. A charge that ought to belong and does not is a matching problem:
          correct its merchant name, or widen the rule that defines the series. Editing a transaction
          re-checks which series it belongs to, so a correction takes effect straight away.
        </p>
        <p>
          A transaction carries a small ↻ marker while it belongs to a series, and its editor links through
          to that series. Right-clicking a transaction offers <em>Mark as recurring</em>, <em>Remove</em>,
          or <em>Restore</em>, whichever fits.
        </p>

        <h4>What needs attention</h4>
        <p>
          The Recurring page has three views, chosen from the selector under its title: the
          <em> Series</em> list itself, <em>Needs attention</em>, and <em>Upcoming</em>. The count beside
          <em> Needs attention</em> is how many findings are open, so it is visible without switching.
        </p>
        <p>
          Each finding names one thing and offers the action that settles it. The same items appear on
          the Tasks page as a reminder to come back to them.
        </p>
        <ul>
          <li>
            <strong>Missing charge</strong> -- an occurrence that was due and never arrived. Lateness is
            measured against how current the data is rather than against the calendar, so a ledger that
            has not been imported into for a while stays quiet instead of reporting every series at once.
            After a couple of missed cycles the series is treated as probably canceled, and
            <em> Mark ended</em> is offered alongside it. Nothing is ended automatically.
          </li>
          <li>
            <strong>Amount changed</strong> -- a charge that came in away from what the series has been
            charging. A series with a steady price reports a modest step; one that moves every month
            reports only a charge beyond anything it has done before. Once a second charge arrives at the
            new price the change is treated as the new normal and stops being reported.
          </li>
          <li>
            <strong>Newly detected</strong> -- a series found for the first time in the last month. This
            is where a forgotten trial that has started billing turns up.
          </li>
          <li>
            <strong>Outside a rule’s range</strong> -- a charge that a rule would have claimed except for
            its amount. An amount range decides which transactions a rule matches, so a bill that grows
            past the limit quietly stops being categorized by that rule and drops out of its series.
            <em> Widen to include</em> moves the limit out to that charge and re-applies the rule. A charge
            that is still inside the range but close to a limit is reported the same way, one occurrence
            earlier.
          </li>
        </ul>
        <p>
          <em>Open series</em> on a finding opens that series’ transactions in a panel below the
          findings, without leaving the list being worked through.
        </p>
        <p>
          A finding can be <strong>dismissed</strong> once it has been seen. Dismissal covers that one
          finding only -- a later missed cycle, or a different charge, is reported again. Anything
          dismissed stays listed at the foot of the section and can be brought back.
        </p>
        <p>
          On a bill whose amount moves -- gas, electricity, water -- dismissing an amount also
          <strong> teaches the range</strong>. A heating bill that peaks every January is worth
          mentioning the first winter and not the ones after, and dismissing that peak is what says so:
          later charges up to the amounts already accepted pass without comment, while a charge beyond
          them is still reported. Restoring a dismissal takes the acceptance back with it. Fixed-price
          subscriptions work differently on purpose -- there a dismissal means the price rose, and the
          next increase is still reported.
        </p>

        <h4>What is coming up</h4>
        <p>
          The <em>Upcoming</em> view lists the charges due in the next month with what they are expected
          to cost, and a total. Nothing there is wrong, so it carries no actions, no dismissal, and never
          appears on the Tasks page -- it is there to be consulted, not resolved. It sits alongside
          <em> Needs attention</em> rather than inside it for that reason.
        </p>

        <h4>Ended is not the same as not recurring</h4>
        <p>The two look alike and behave differently.</p>
        <ul>
          <li>
            <strong>Ended</strong> is a real series that has stopped -- a canceled subscription. It is kept
            as history and left out of what is coming up, but it is not blocked. If a matching transaction turns
            up again, the same series resumes instead of a duplicate being created.
          </li>
          <li>
            <strong>Not recurring</strong> sets a mistaken detection aside for good. It will not be
            suggested again.
          </li>
        </ul>
        <p>
          See also:{' '}
          <HelpLink to="/help/parts-of-luma">how rules come into being</HelpLink> and{' '}
          <HelpLink to="/help/re-categorizing">what changes a transaction’s category</HelpLink>.
        </p>
      </>
    ),
  },
  {
    id: 'data-and-backups',
    section: 'access-safety',
    title: 'Your data on disk, and backups',
    surfaces: ['Intended usage (Settings)'],
    summary: `Your transactions live in a plain-text database on this machine -- protected by your computer, not by ${APP_NAME}. Treat that file as sensitive: don’t copy it around, and move data with an encrypted backup instead.`,
    body: () => (
      <>
        <p>
          {APP_NAME} keeps everything in a local SQLite database on the machine it runs on. The
          transaction ledger &mdash; accounts, transactions, categories, tags &mdash; is stored in{' '}
          <strong>plain text</strong>. It is protected by your computer’s own security (disk encryption,
          your OS login, who can physically reach the machine), not by anything {APP_NAME} does to the
          file. The sign-in password guards <em>network</em> access to the app; it does not encrypt the
          file on disk.
        </p>
        <p>
          The practical consequence: <strong>treat the database file as sensitive.</strong> Copying it to
          a shared drive, emailing it, or syncing it to the cloud exposes the whole ledger in the clear
          to anyone who can read it there. To move or archive your data, use {APP_NAME}’s{' '}
          <strong>backup</strong> (on the Import / Export page) rather than the raw file &mdash; a backup
          can be <strong>encrypted</strong> with a key you supply, so it is safe to store or carry.
        </p>
        <p>
          Connecting a bank or data provider is the most sensitive thing you can store, because it holds
          live, ongoing access to that account. Unlike the transaction ledger, those credentials are{' '}
          <strong>encrypted on disk</strong> &mdash; sealed with a strong password of their own, separate
          from and unaffected by the account sign-in password policy &mdash; so they stay protected even
          where the rest of the database does not. The sign-in side of access is covered in{' '}
          <HelpLink to="/help/account-security">account security</HelpLink>.
        </p>
        <p>
          If a database file or an unencrypted backup ever gets loose, the transactions it held are
          already exposed &mdash; but the live access can still be cut off, and that is the part worth
          acting on. <strong>Disconnect</strong> on the Connections tab is the way to do it.{' '}
          <strong>How far it reaches depends on the provider:</strong> some accept a revocation from{' '}
          {APP_NAME}, which ends the access outright; others offer no such call, so Disconnect removes
          only {APP_NAME}’s copy and the access stays valid until it is revoked at the provider itself.
          The confirmation shown before disconnecting says which of the two applies, so a connection is
          never left live while appearing closed.
        </p>
        <p>
          Revoking at the provider instead works too, and the Connections tab notices: once the provider
          stops accepting the stored credential, the card reports <strong>reconnect needed</strong> rather
          than counting failed syncs. That is a different message from an ordinary sync failure on purpose
          &mdash; a failing connection may recover on its own, while a revoked one never will until it is
          set up again.
        </p>
      </>
    ),
  },
  {
    id: 'account-security',
    section: 'access-safety',
    title: 'Account security: password and two-factor',
    surfaces: ['Account security (Settings)'],
    summary: `Sign-in protection is a network perimeter -- it keeps people who aren’t users out. It is not disk encryption, and everyone signed in shares the same data. Two-factor adds a code at sign-in and is optional.`,
    body: () => (
      <>
        <p>
          Sign-in protection exists to keep <strong>non-users out</strong> &mdash; it is a perimeter
          around the app, not a wall between the people who use it. Everyone who signs in sees and edits
          the <strong>same shared data</strong>; the password does not scope one person’s transactions
          away from another’s. And it guards <em>network</em> access only: it is not disk encryption, so
          it is not a substitute for keeping the machine itself secure (see{' '}
          <HelpLink to="/help/data-and-backups">your data on disk</HelpLink>).
        </p>
        <p>
          <strong>Password policy</strong> sets how strong account passwords must be. It applies to
          everyone, and you can tighten or relax it at any time.
        </p>
        <p>
          <strong>Two-factor (an authenticator app)</strong> adds a one-time code after the password.
          When it is on, you enter that code on <strong>every fresh sign-in</strong> &mdash; a browser
          with an active session is not asked again until that session ends, but there is no &ldquo;trust
          this device&rdquo; that skips the code on a new sign-in. If you lose the authenticator, the{' '}
          <strong>recovery codes</strong> shown when you turn it on are the way back in, so save them
          somewhere safe.
        </p>
        <p>
          Two-factor is optional and mainly matters if this instance is reachable beyond your trusted
          network. On a single machine or a trusted home network it adds little &mdash; leaving it off is
          reasonable, and it does nothing unless enabled.
        </p>
      </>
    ),
  },
  {
    id: 'configuration',
    section: 'access-safety',
    title: 'Configuration: what is set where',
    surfaces: ['Configuration (Settings)'],
    summary: `No configuration file is required -- every setting has a working default, and the few that must persist are generated on first run. An optional .env file overrides the handful of values that are read before the app starts, such as ports and where the databases live.`,
    body: () => (
      <>
        <p>
          Nothing has to be configured before {APP_NAME} runs. Every setting falls back to a working
          default, and the two values that must survive a restart &mdash; the key that signs session
          cookies, and the session cookie&rsquo;s name &mdash; are generated on first run and kept in the
          database. A plain installation needs <strong>no configuration file at all</strong>.
        </p>
        <p>
          The settings that matter day to day are not on this panel at all &mdash; they live beside the
          feature they belong to, and take effect immediately. What remains here is the small set read{' '}
          <strong>once, at startup</strong>, before the app is running, which is exactly why the panel
          reports values rather than offering fields to edit. A control that accepted a value and changed
          nothing until the next restart would read as broken.
        </p>
        <p>
          Three of them are worth knowing about. <strong>Data directory</strong> is where both database
          files live &mdash; the one setting to change to move an installation&rsquo;s data, or to run a
          second installation on the same machine. The two database rows beneath it are shown for
          confirmation and follow it automatically. <strong>Backend port</strong> and{' '}
          <strong>frontend port</strong> are read before the server binds. Everything else sits under{' '}
          <strong>Advanced</strong>: naming, launcher behavior, and deployment details most installations
          never touch. A setting that has actually been overridden is shown in the main list either way,
          since overriding it is a sign it matters here.
        </p>
        <p>
          Each row names where its value came from. <strong>Default</strong> is the built-in value.{' '}
          <strong>Stored</strong> means it was generated once and kept in the database.{' '}
          <strong>Derived</strong> means it follows another setting. <strong>Set in .env</strong> or{' '}
          <strong>Set in environment</strong> means an override is in force &mdash; an override always
          wins, and always takes effect at the next restart. The optional file lives beside the
          application; the panel says where, and whether one is present.
        </p>
        <p>
          Stored values can be cleared but not typed. <strong>Reset</strong> forgets a stored value so the
          current default applies again, and <strong>Regenerate</strong> replaces the session signing key
          &mdash; worth doing if it may have been exposed, such as in a shared backup. Both take effect at
          the next restart, and both end every active session, so everyone signs in again. Neither is
          offered while an override is in force, because the override would still win. Where the data
          itself lives, and how to move it safely, is covered in{' '}
          <HelpLink to="/help/data-and-backups">your data on disk</HelpLink>.
        </p>
      </>
    ),
  },
]

export const HELP_TOPICS_BY_ID = Object.fromEntries(HELP_TOPICS.map(t => [t.id, t]))
