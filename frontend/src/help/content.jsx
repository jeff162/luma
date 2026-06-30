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
    key: 'reports',
    label: 'Reports & search',
    blurb: 'Getting answers back out: dashboard breakdowns and searching the history.',
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
          dashboard) and <strong>searching</strong> the transaction history. All of the other features --
          accounts, owners, categories, tags, and rules -- exist to make those two better, and
          can be used or not as fits your use case.
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
            <strong>Tags.</strong> Cross-cutting labels used to identify transactions belonging to some
            interesting group across owner, account, and category --
            think <em>Essential Expenses</em> or <em>Kids</em> -- and apply to income and expenses
            alike. See <HelpLink to="/help/tags">how tags work</HelpLink>.
          </li>
          <li>
            <strong>Rules.</strong> How categories and tags get applied to new transactions as they
            arrive (and how merchant names get normalized). More on this below but if categories are
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
          There are two main ways rules get created:
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
          A tag can be attached at three levels, and a transaction’s <strong>effective
            tags</strong> are the additive union of all three:
        </p>
        <ul>
          <li><strong>Direct (transaction-level)</strong> &mdash; added by a matching rule, or by
            manually editing one transaction. Manual edits override the rule for that one row.</li>
          <li><strong>Category-level</strong> &mdash; a tag attached to a leaf category propagates
            to every transaction in that category.</li>
          <li><strong>Group-level</strong> &mdash; a tag attached to a category group propagates to
            every transaction in any of the group’s leaves.</li>
        </ul>
        <p>
          Pick the level that matches the intent. A tag like <em>Bills</em> probably belongs on a
          group; a tag like <em>Reimbursable</em> often belongs on individual transactions via a
          rule that recognizes the merchant. Composing across levels is fine &mdash; the same tag
          can be on a group and on individual transactions.
        </p>
        <p>
          Inherited tags can’t be removed from a single transaction today. To opt one out,
          re-tag at the level the inheritance comes from.
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
          categorized <em>by hand</em> or kept from a <em>trusted import</em>. A rule-assigned row that
          no longer matches any rule falls back to uncategorized. It is the pass to run after adding or
          changing rules, to refresh categorization without disturbing manual work or imported
          categories.
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
          <li><strong>Rule</strong> -- assigned by a matching rule. Not protected: re-evaluated by Run
            categorization and replaced by any apply.</li>
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
          To check a single transaction’s current source, open its detail panel: a small pinned label
          sits beside the category, and the details show a <em>Categorized by</em> line naming the
          source -- a rule, a manual edit, or the category present in the source data.
        </p>
      </>
    ),
  },
  {
    id: 'duplicate-report',
    section: 'duplicates',
    title: 'Reading the duplicate-detection report',
    surfaces: ['Import / Export (file ↗ report)', 'Duplicate-detection report'],
    summary: 'When the same activity arrives from more than one source, this report resolves the clear cases and groups the rest into pills. Review is an undecided match that needs a decision — and the only category counted as pending work (the file’s “to review” count and the Tasks warning). Rejected · review (Matched ±2 days, No specific match) are already rejected and advisory: examine it, Import anyway if it shouldn’t have been rejected, or Mark reviewed. Click a pill to show just that group; hover a pill for a short explanation.',
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
          <li><strong>Rejected &middot; review</strong> &mdash; <strong>Matched &plusmn;2 days</strong> and
            <strong> No specific match</strong>. These were already rejected at import and are
            <em> advisory</em> &mdash; they do <strong>not</strong> count as pending work. Examine them to
            confirm the rejection was right; a row that should <em>not</em> have been rejected can be kept
            with <strong>Import anyway</strong>, and the rest can be left alone or cleared from the pills
            with <strong>Mark reviewed</strong> (in bulk). Often a <strong> No specific match</strong> transaction
            can be matched to a transaction further outside of the ±2 day window but sometimes it really is a
            transaction which should be included. See{' '}
            <HelpLink to="/help/covered-range-review">covered-range review</HelpLink>.</li>
        </ul>
        <p>
          <strong>Click a pill</strong> to show just that group (the header checkbox then selects all of
          it); <strong>hover a pill</strong> for a short explanation of what it means.
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
    title: 'Reviewing covered-range duplicates (±2 days / no match)',
    surfaces: ['Duplicate-detection report'],
    summary: 'When an earlier import already covered a date range, every transaction in that range is expected to already be present, so each new row landing in it is paired against the existing data by date and amount (exact, then ±1, then ±2 days). Two pairing outcomes are surfaced for review: Matched ±2 days (a counterpart turned up only after widening the window — posting dates drift between sources from pending/posted timing, weekend settlement, or time zones) and No specific match (nothing paired at all, so the row may be genuinely missing from the earlier import).',
    body: () => (
      <>
        <p>
          When an earlier import already covered a date range, every transaction in that range is expected to
          already be in the ledger, so a newly-imported row landing inside it is rejected as a presumed
          duplicate and paired against the existing data by date and amount &mdash; the exact date first, then
          &plusmn;1 day, then &plusmn;2 days. Two of the pairing outcomes are surfaced for review:
        </p>
        <ul>
          <li><strong>Matched &plusmn;2 days</strong> &mdash; a counterpart turned up only after the date
            window widened to &plusmn;2 days. Posting dates drift between sources for several reasons &mdash;
            pending vs. posted timing, weekend or holiday settlement, and time-zone differences on foreign
            charges &mdash; so the same transaction can sit a day or two apart in two sources. Once the pair
            looks right, <strong>Mark reviewed</strong> (in bulk from the pill, or per row) clears it from the
            needs-attention list. If a pair turns out <em>not</em> to be the same transaction, select the rows
            and import both.</li>
          <li><strong>No specific match</strong> &mdash; the date is covered but nothing paired with it at
            all, even at &plusmn;2 days. That makes it the row to actually investigate: it is usually present
            in one source and genuinely missing from the other, in which case <strong>Import anyway</strong>
            keeps it.</li>
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
          mysteriously disappear.
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
]

export const HELP_TOPICS_BY_ID = Object.fromEntries(HELP_TOPICS.map(t => [t.id, t]))
