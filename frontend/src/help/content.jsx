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
          New transactions usually come in together -- a CSV, a series of CSV files, or a data connection.
          Some get categorized automatically by rules along the way. It is worth looking the new ones over
          before trusting them, to catch any mistakes. And now and then a transaction that matched a rule is
          really an exception that belongs in a different category. So every imported or synced transaction
          starts out flagged <strong>needs review</strong>, with a small <strong>R</strong> marker in its row.
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
          On the Transactions page, the <strong>Needs review</strong> filter narrows the list to the flagged
          transactions, the same way the uncategorized filter does. Sorting that list by amount deals with the
          largest transactions first.
        </p>
        <p>
          A long historical import flags a lot of transactions at once, and reviewing all of it is usually not
          worth the trouble. Each imported file’s card on the Import / Export page shows a <strong>to
            review</strong> count and a <strong>Mark all reviewed</strong> button that clears the whole file in
          one click. A data connection has no per-file card yet. Its transactions are cleared with
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
    id: 'recurring-transactions',
    section: 'recurring',
    title: 'Recurring transactions',
    surfaces: ['Recurring', 'Rules (recurring series)', 'Transactions (row menu)'],
    summary: 'A recurring series tracks a transaction that repeats on a schedule. Many are found automatically by looking for similar looking transactions on a fixed schedule.Recurring transactions the scan misses can be identified by creating a Rule. Per-transaction overrides exist for the exceptions.',
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
          <li>
            <strong>Add a transaction</strong> -- pins a specific transaction into the series even if it would
            not match on its own.
          </li>
        </ul>
        <p>
          A transaction carries a small ↻ marker while it belongs to a series, and its editor links through
          to that series. Right-clicking a transaction offers <em>Mark as recurring</em>, <em>Remove</em>,
          or <em>Restore</em>, whichever fits.
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
]

export const HELP_TOPICS_BY_ID = Object.fromEntries(HELP_TOPICS.map(t => [t.id, t]))
