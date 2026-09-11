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
 *
 * A link whose text names a *heading* rather than a whole topic should address
 * that heading -- `to="/help/<topic>#<anchor>"`, with the heading authored as
 * `<HelpHeading anchor="...">` instead of a bare `<h4>` -- or the reader lands
 * at the top of a long body with the promised part out of sight.
 */

import HelpLink from './HelpLink.jsx'
import HelpHeading from './HelpHeading.jsx'
import { APP_NAME } from '../lib/appConfig.js'

/*
 * Help-index sections. The standalone /help page groups topics under these headings, in this
 * order; each topic carries a `section` key matching one of these. Section order here -- not the
 * array order of HELP_TOPICS below -- is what drives how the index reads; within a section,
 * topics appear in their HELP_TOPICS order. The inline FeatureExplainer popovers look topics up
 * by `id` and ignore sections entirely. A topic whose `section` matches nothing here still shows
 * (under a trailing "More" group) rather than silently vanishing.
 *
 * How the sections are chosen: most mirror a page in the left nav, in nav order, and lead with that
 * page's `page-*` hub topic -- the one its title's `?` opens, which also collects the page's related
 * topics as links. The rest are subjects that outgrew a single page and stand on their own
 * ("Duplicates & reconciliation", "Access & data safety"), because a topic does **not** have to sit
 * under the hub of the page it is reached from: a topic carries one `section` but several
 * `surfaces`, so it is filed by *subject* and the other pages' hubs link across to it. Ordering
 * within a section is deliberate rather than the order topics were written -- hub first, then the
 * core model, then common tasks, then edge cases -- because array position is the only thing
 * driving it.
 */
export const HELP_SECTIONS = [
  {
    key: 'getting-started',
    label: 'Getting started',
    blurb: `What ${APP_NAME} is for, and loading the first data.`,
  },
  {
    key: 'dashboard',
    label: 'Dashboard',
    blurb: 'Reading the reports: what each breakdown counts, and the alternate frames.',
  },
  {
    key: 'transactions',
    label: 'Transactions',
    blurb: 'Working the ledger: finding a transaction, reviewing new ones, and recording what a row does not say on its own.',
  },
  {
    key: 'categories',
    label: 'Categories & tags',
    blurb: 'Two ways to organize transactions for reports: a category tree and cross-cutting tags.',
  },
  {
    key: 'rules',
    label: 'Rules',
    blurb: 'How categorization is kept up automatically, and what happens when two rules want the same transaction.',
  },
  {
    key: 'accounts',
    label: 'Accounts',
    blurb: 'Where transactions come from, and pairing up accounts that turn out to be the same one.',
  },
  {
    key: 'recurring',
    label: 'Recurring transactions',
    blurb: 'Transactions that repeat on a schedule: what the scan finds on its own, and how to declare one it cannot see.',
  },
  {
    key: 'importing',
    label: 'Importing data',
    blurb: 'Mapping files, saving reusable sources, and bringing in marketplace order detail.',
  },
  {
    key: 'duplicates',
    label: 'Duplicates & reconciliation',
    blurb: 'When the same activity arrives from more than one source: what the engine settles on its own, and how to resolve what it cannot.',
  },
  {
    key: 'tasks',
    label: 'Tasks',
    blurb: 'The nag list: what gets raised there, and what dismissing one means.',
  },
  {
    key: 'settings',
    label: 'Settings',
    blurb: 'The one page of preferences, and what each section of it covers.',
  },
  {
    key: 'access-safety',
    label: 'Access & data safety',
    blurb: 'What sign-in protection and two-factor guard, and what stays on the machine: the ledger on disk, and backups.',
  },
]

export const HELP_TOPICS = [
  {
    id: 'how-luma-works',
    section: 'getting-started',
    title: `How ${APP_NAME} works`,
    surfaces: ['Getting started', 'Dashboard'],
    summary: `${APP_NAME} is for two things: reports (mostly the dashboard) and searching the transaction history. Everything else (accounts, owners, categories, tags, rules) exists to make these two better.`,
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
          connection unless specifically requested (e.g. downloading
          transactions from a data provider, storing a backup on a cloud service).
        </p>
        <p>
          To get started:
        </p>
        <ol>
          <li>
            Load transactions - Use the Import/Export page or connect a Data source. If there are
            several files to be imported, import them all at once before moving on. If files come from
            different sources, accounts can be mapped so they match. If this
            is not done during the import process, it can be done later on the Accounts page. If files do
            come from different data sources consider creating saved profiles for them so the import settings
            get applied automatically on subsequent files from the same source. Loading transactions creates the
            accounts which they are mapped to.
          </li>
          <li>
            Account Owners - Create the account owner(s) and assign them to accounts. If more than one owner is
            created, <strong>shared</strong> becomes available as a choice. Account Owner is a field that can be
            filtered on.
          </li>
          <li>
            Tags - Tags support reporting that is hard to do with the other controls. This could be because
            the interesting transactions cross categories and accounts, such as Essential Expenses, or it could be
            that there are two different sets of conditions that select the interesting set of records and there is no
            way to express that in the filters. Tags can be baked into rules and are available as a bulk edit action in
            addition to being part of the transaction editor.
          </li>
          <li>
            Create Categories and Rules - There are two paths to getting started with categories:
            <ol type="a">
              <li>
                If the imported data was curated and contains useful
                transaction categorization, this can be noted during the import or on the import record, and
                the <strong>Group imported categories</strong> and <strong>Generate rules</strong> buttons
                on the Import/Export page can bring them in to the system and propose matching rules based on
                the transactions' existing categorization.
              </li>
              <li>
                <p>
                  If not but categories are of interest, the built-in set of seed categories and rules can be loaded
                  via the <strong>Add starter categories</strong> button on the Categories page and/or
                  the <strong>Starter rules</strong> button on the Rules page (this button also brings in categories).
                </p>
                <p>
                  It is also fine not to load the system categories or rules. It may be useful to define some groups and
                  categories up front, just to give some thought as to how the transactions might be organized, but this
                  can also be done when categorizing transactions. It is rarely a good idea to generate
                  rules manually as it is easier to create them as part of categorizing transactions.
                </p>
              </li>
            </ol>
          </li>
          <li>
            Categorize transactions - if categories are of interest the transaction page can
            filter so only uncategorized transactions are displayed. Assigning a transaction to a category triggers
            a <strong>Create Rule</strong> toast which offers to create a rule from the categorization. The form
            offers the opportunity to edit the conditions and actions of the rule and when saving, the rule can be
            applied to existing matching transactions. Assigning a category also changes a transaction to reviewed.
          </li>
          <li>
            Use the <strong>Dashboard</strong> page to dig into categories to see if things look right.
          </li>
        </ol>
      </>
    ),
  },
  {
    id: 'parts-of-luma',
    section: 'getting-started',
    title: `The parts of ${APP_NAME}`,
    surfaces: ['Getting started'],
    summary: 'A tour of the app, in the order data moves through it: importing, accounts and owners, the ledger, categories and groups, tags, rules, recurring charges, the dashboard, tasks and settings -- each handing off to its own topic.',
    body: () => (
      <><p>*Needs review*</p>
        <p>The major modules, roughly in the order data moves through them:</p>
        <ol>
          <li>
            <strong><HelpLink to="/help/page-import-export">Import / Export</HelpLink>.</strong>{' '}
            Load data, create backups and export data. Transactions come in
            via a CSV file or a connected data source. There is strong
            duplicate detection to deal with overlapping sources or overlapping imports from a single
            source. When the duplicate-detection code encounters a situation it is not sure how to resolve
            it surfaces the conflict(s) in a report launched
            from the file card for the import (on the Import/Export main page). Detailed purchase data from sources
            such as Amazon can also be imported in a CSV format to provide additional detail for transactions which
            otherwise appear as a generic transaction.
          </li>
          <li>
            <strong><HelpLink to="/help/page-accounts">Accounts and owners</HelpLink>.</strong>{' '}
            Transactions arrive tagged with an account or are mapped to an account
            when they are imported.
            An account can matter on its own, a card used for a specific purpose, or as a way to attribute
            a transaction to an <em>owner</em> for reports and rules. It can be worth bringing in data from
            the individual spending sources &mdash; credit cards, P2P, loan accounts &mdash; since they
            carry the richest per-merchant detail. The alternative is that the credit card purchases will be
            represented by the monthly credit-card payment in the ledger. If the detail
            is not interesting, there is no need to use more than the bank account. If the transactions from
            the actual spending account are imported then to avoid double counting, the <strong>Category </strong>
            which <em>Credit card payment</em>s are assigned to should be a member of a group such
            as <em>Transfers</em> which is marked <strong>Exclude from totals</strong> {' '}
            (<HelpLink to="/help/exclude-from-totals">excluded from totals</HelpLink>).
          </li>
          <li>
            <strong><HelpLink to="/help/page-transactions">Transactions</HelpLink>.</strong>{' '}
            The ledger itself, as a list: everything that has been
            imported, with everything recorded about a transaction reachable from its row. New arrivals are
            flagged for review, a set of rows can be worked through together, and this is also where the
            things a single row cannot express are recorded -- a purchase split across several categories,
            one purchase paid off in several payments, an expense that is owed back.
          </li>
          <li>
            <strong><HelpLink to="/help/page-categories">Categories and groups</HelpLink>.</strong>{' '}
            Transactions can be assigned to categories, and categories
            are collected into groups, mainly to drive reports and to select related transactions.
            The system contains a seed set of rules and categories which can be used if none are defined.
            <p>
              Some groups also carry behavior that is useful even when categories are not being used for
              reporting. A group marked <HelpLink to="/help/exclude-from-totals">Exclude from
                totals</HelpLink> keeps money movement such as credit-card payments and transfers out of
              the spending and income figures, and
              the <HelpLink to="/help/reimbursable-expenses">Reimbursable</HelpLink> group tracks money
              that is expected to be paid back. Both ship with the exclusion already set.
            </p>
          </li>
          <li>
            <strong>Tags.</strong> Tags are used to create spending reports that are not otherwise
            available on the dashboard. These are labels used to identify transactions belonging to some
            interesting group that is not captured by something else in the application.
            See <HelpLink to="/help/tags">how tags work</HelpLink>.
          </li>
          <li>
            <strong><HelpLink to="/help/page-rules">Rules</HelpLink>.</strong>{' '}
            Rules have a set of criteria to select the set of
            transactions they apply to and a set of actions to take when they apply. The
            actions include setting the merchant name, assigning a category or a tag and indicating
            whether the transaction is part of a recurring series. Few are written by hand &mdash;
            see <HelpLink to="/help/page-rules#how-rules-come-into-being">how rules come into being</HelpLink> &mdash;
            but if categories are
            important, this is how they are maintained on incoming data. Building up a set of rules can make
            the review process of new transactions fairly quick and painless.
          </li>
          <li>
            <strong><HelpLink to="/help/recurring-transactions">Recurring transactions</HelpLink>.</strong>{' '}
            Charges that repeat on a schedule, such as
            subscriptions, utilities and loan payments. Most are found by a scan for similar transactions
            arriving on a fixed cadence; one the scan cannot see is declared through a rule. Once a series
            is known, a charge that goes missing or changes amount raises an alert.
          </li>
          <li>
            <strong><HelpLink to="/help/page-dashboard">The dashboard</HelpLink>.</strong>{' '}
            Reports live here, and it doubles as a way to check
            the data -- drill into the largest groups, see the transactions behind them, fix
            anything misclassified.
          </li>
          <li>
            <strong><HelpLink to="/help/page-tasks">Tasks</HelpLink>.</strong>{' '}
            A short list of things worth a look: transactions with no
            category, duplicates awaiting a decision, reimbursements outstanding too long, a recurring
            charge that did not arrive. Nothing there is an error, and nothing has to be dealt with in
            order.
          </li>
          <li>
            <strong><HelpLink to="/help/page-settings">Settings</HelpLink>.</strong>{' '}
            Appearance and currency, the tag manager, sign-in
            protection, the trash, and the configuration screen. Almost none of it has to be touched to
            use the app.
          </li>
        </ol>
      </>
    ),
  },
  {
    id: 'design-principles',
    section: 'getting-started',
    title: `How ${APP_NAME} is designed to be used`,
    surfaces: ['Getting started'],
    summary: `A few deliberate choices shape how ${APP_NAME} behaves: categorization that compounds instead of repeating, editing in place, non-destructive toggles, and dedupe that makes overlapping imports safe. Knowing the reasoning makes the rest of the app easier to use.`,
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
            <strong>Categorization compounds.</strong> Categorizing a
            transaction can become a rule that reproduces the same
            decision across every matching transaction and on future imports. Time spent
            refining a few good rules pays off more than re-touching individual rows. See{' '}
            <HelpLink to="/help/page-rules#how-rules-come-into-being">how rules come into being</HelpLink>.
          </li>
          <li>
            <strong>Editing happens where the data is shown.</strong> Wherever a thing is viewed it
            can usually be updated, and anything assignable -- a category, a tag, an
            owner -- can be created right there. There is rarely a need to find a
            separate settings screen to make a change.
          </li>
          <li>
            <strong>Use the features which are useful, ignore those which are not.</strong> Reports and search
            are the two things {APP_NAME} exists to do well; accounts, owners, categories, tags, and
            rules all exist to make those better. None are mandatory, and each can be left aside
            until a need for it arises -- there is no obligation to fill everything
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
            manual choice overrides what a rule would otherwise do.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'page-dashboard',
    section: 'dashboard',
    title: 'The Dashboard',
    surfaces: ['Dashboard'],
    summary: 'A visual way to explore the ledger. Spending and income are shown as charts rather than lists, which suits both reporting and checking that transactions are filed where they belong.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          The dashboard answers two questions: where the money went, and how that compares with other
          periods. Three controls decide what is on screen.
        </p>
        <ul>
          <li>
            <strong>The period and the filters</strong> decide which transactions are counted. The
            filter bar narrows by account, owner, tag, category or any other facet, and every figure
            on the page follows it.
          </li>
          <li>
            <strong>Spending by</strong> decides how the total is divided: by group, by category, or
            by a saved <HelpLink to="/help/dashboard-tag-reports">tag report</HelpLink>.
          </li>
          <li>
            <strong>The frame</strong> chooses between a single period, trends across several periods,
            and <HelpLink to="/help/dashboard-cash-flow">cash flow</HelpLink>.
          </li>
        </ul>
        <p>
          Every chart drills down. Clicking a group opens its categories, clicking a category opens
          the transactions behind it, and anything filed wrongly can be corrected from there. Using
          the dashboard to check the data is as much its purpose as reporting on it.
        </p>
        <p>
          Not everything is counted. Categories in a group
          marked <HelpLink to="/help/exclude-from-totals">Exclude from totals</HelpLink> are left out
          of every figure here, which is how credit-card payments and transfers between accounts stay
          out of spending.
        </p>
      </>
    ),
  },
  {
    id: 'dashboard-cash-flow',
    section: 'dashboard',
    title: 'Cash flow',
    surfaces: ['Dashboard frame selector'],
    summary: 'Another way to view spending showing what came in against what went out. Single period uses a Sankey diagram; Trends displays money in and money out as a bar graph.',
    body: () => (
      <>
        <p>
          <strong>Cash flow</strong> combines spending and income into one graph. It is
          based on transaction dates as opposed to actual money movement. This means that a
          credit card transaction is treated as being paid for on the date it posted rather than the
          date on which the credit card payment was made so the time frame of how income and expenses
          offset is not 100% accurate.
        </p>
        <p>
          The Sankey diagram used for the <strong>single period</strong> report depicts income on the
          left, the net in the middle, and expenses on the right. The width of each band is the
          amount, and the labels and hover text carry the value. Clicking a band drills down into it
          the same way it works on the pie chart: a group opens its categories, a category opens its
          transactions. Where a long tail of small buckets becomes too thin to read, the remainder
          collapses into a single <em>Other</em> band that can be clicked to open the details.
        </p>
        <p>
          The two sides rarely balance. A period that took in more
          than it spent ends in a <strong>Net saved</strong> band; one that spent more is funded by
          a <strong>Net drawdown</strong> band on the incoming side. That band stands for the
          difference itself rather than for any transactions, so it is the one band that does not
          open.
        </p>
        <p>
          <strong>Trends</strong> displays cash flow as a bar per month around a zero line
          &mdash; money in above it, money out below, with the net drawn across them and the average
          net marked. Clicking a month opens its transactions; double-clicking switches to the
          single-period view for that month.
        </p>
        <p>
          A category's <strong>net</strong> for the period decides which side it lands on.
          A month where returns outweighed purchases puts that category
          on the incoming side; income clawed back lands on the outgoing side. This is also why the
          figures net rather than gross: a purchase and its later refund in the same category and
          period combine to a single net amount, not as two separate movements.
        </p>
        <p>
          Transactions which are excluded from totals because the category
          assignment indicates they are money movement or reimbursement related
          (see <HelpLink to="/help/exclude-from-totals">groups excluded from totals</HelpLink>) are
          not included in the cash flow reports the same as they
          are not included in the other dashboard reports.
        </p>
        <p>
          Tag reports are not offered in this frame. A tag signature mixes categories from both
          directions, so it has no single direction to net; tags, like other criteria, can be used
          as filters for all of the reports.
        </p>
        <p>
          See also: <HelpLink to="/help/exclude-from-totals">Excluding a group from totals</HelpLink>
        </p>
      </>
    ),
  },
  {
    id: 'dashboard-tag-reports',
    section: 'dashboard',
    title: 'Dashboard tag reports',
    surfaces: ['Dashboard "Spending by…" picker'],
    summary: 'Any combination of tags can be used to produce an income or expense report. Each tag becomes a wedge and combinations can be saved as custom tag reports.',
    body: () => (
      <>
        <p>
          The dashboard's "Spending by…" picker offers two built-in breakdowns
          (<em>group</em>, <em>category</em>) plus saved tag reports. A tag report is a
          set of tags that become the wedges along with the <em>remaining</em> category. For example
          if tags exist to track the owners, a <em>Per-owner</em> report could be built from tags Alice, Bob, Shared.
        </p>
        <p>
          Click <strong>+ Tag report</strong> in the picker to build one. Check the tags
          to include and either press <em>Save &amp; display</em> to save the report
          or <em>Display</em> to see the report without saving.
          Right-click (or use the &middot;&middot;&middot; menu) to rename or delete a saved report.
        </p>
        <p>
          Each unique combination of selected tags found in the transaction data becomes its own
          wedge &mdash; so a transaction tagged both <em>Alice</em> and <em>Essential</em> shows up
          in an "Alice + Essential" wedge rather than being assigned to one or the other. A
          transaction matching none of the selected tags falls into a synthetic
          <em> Other / Untagged</em> wedge so the wedges sum to 100% of the transactions.
        </p>
        <p>
          See also: <HelpLink to="/help/tags">How tags work</HelpLink>
        </p>
      </>
    ),
  },
  {
    id: 'page-transactions',
    section: 'transactions',
    title: 'The Transactions page',
    surfaces: ['Transactions'],
    summary: 'The transaction ledger itself, as a list. Everything recorded about a transaction is reachable from its row, and the same list is where a set of them is worked through together.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          Every transaction in the ledger is listed here. The quick filter above the table narrows to
          a working set such as <HelpLink to="/help/reviewing-transactions">Needs review</HelpLink> or
          uncategorized rows, while the filter bar at the top of the page narrows by account, owner,
          category, tag, date or amount. The two combine.
        </p>
        <p>
          <strong>Bulk Edit</strong> turns the list into a selectable set, for categorizing, tagging,
          marking reviewed, trashing, or linking several payments into one purchase. A single
          transaction is worked on from its right-click menu or from the detail panel, which opens
          beside the list and holds everything recorded about the row.
        </p>
        <h4>Markers on a row</h4>
        <p>
          A small marker says something is recorded beyond the amount and the category. Each one opens
          what it refers to.
        </p>
        <ul>
          <li><strong>R</strong> &mdash; the transaction is new and <HelpLink to="/help/reviewing-transactions">needs review</HelpLink>.</li>
          <li><strong>Split (N)</strong> &mdash; the amount is <HelpLink to="/help/transaction-splits">divided across categories</HelpLink>.</li>
          <li><strong>&#128279;</strong> &mdash; one of <HelpLink to="/help/multi-payment-purchases">several payments for one purchase</HelpLink>.</li>
          <li><strong>&#8617;</strong> &mdash; a <HelpLink to="/help/reimbursable-expenses">reimbursable expense</HelpLink> or its repayment.</li>
          <li><strong>&#8635;</strong> &mdash; part of a <HelpLink to="/help/recurring-transactions">recurring series</HelpLink>.</li>
          <li>A paperclip &mdash; the transaction has <HelpLink to="/help/transaction-documents">documents attached</HelpLink>.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'reviewing-transactions',
    section: 'transactions',
    title: 'Needs Review',
    surfaces: ['Transactions (Only… filter)', 'Import / Export (file card)'],
    summary: 'New transactions arrive flagged needs review so they can be looked over before being trusted. The R marker, the Needs review transaction filter, and bulk Mark reviewed are tools to help with this process.',
    body: () => (
      <>
        <p>
          New transactions, whether they are categorized automatically by rules or whether they land
          uncategorized, are flagged <strong>Needs review</strong> with a small <strong>R</strong> marker in a
          transaction report so they are easily identified.
          It may be worth reviewing these to catch any mistakes. Sometimes a transaction that matched a rule is
          an exception that belongs in a different category.
        </p>
        <p>The flag clears three ways:</p>
        <ul>
          <li>Editing the transaction's category clears it. Correcting or setting the category counts as reviewing it.
          </li>
          <li>
            <strong>Mark reviewed</strong>, on the row's right-click menu and in the bulk-edit bar, clears it
            without changing anything else. This covers the common case where everything is correct.
            The transaction filter just above the transaction table has a <em>Needs review</em> option so all the transactions
            to be reviewed can be cleared at once in a bulk-edit option after the ones which needed
            editing have been dealt with. The main filter at the top of the page can be used to limit
            the display to a particular owner, account (or any other set of criteria) if only some of the entries
            should be processed.
          </li>
          <li>
            The import cards on the Import/Export page have a pill with the number of transactions in
            the import which need review. Next to it is a button to <strong>mark all reviewed</strong>.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'searching-transactions',
    section: 'transactions',
    title: 'Searching by date or amount',
    surfaces: ['Transactions search', 'File ledger search'],
    summary: 'The file-ledger and Transactions search boxes match dates and amounts, in addition to merchant names, categories and accounts. Type a year, month, day, or a dollar amount to find the matching transaction(s).',
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
    id: 'transaction-splits',
    section: 'transactions',
    title: 'Splitting one transaction across categories',
    surfaces: ['Transactions (row menu, Split marker)', 'Transaction detail (Split...)'],
    summary: 'A purchase that spans categories, part groceries, part hardware, can have its amount divided into items, each with its own category.',
    body: () => (
      <>
        <p>
          A <strong>split</strong> keeps the purchase as <em>one</em> transaction and divides its amount
          into <strong>items</strong>, each with its own category, its own amount, and an optional
          description. It deliberately does not create child transactions: the ledger still shows one row
          for one purchase, because that is what happened.
        </p>
        <p>
          There are many situations where this can be useful. One example is a purchase from a marketplace such as
          Target, Walmart, Best Buy etc. where a purchase might include several items that fall into different categories.
          Filing the whole amount under a single category overstates that category and causes the other category to under-report
          its spending. Small transactions may not be worth splitting but larger ones probably benefit from being split, if
          reporting spending by category is of interest.
        </p>

        <h4>Adding the split transaction details</h4>
        <p>
          The editor opens three ways -- from the row's right-click menu
          (<strong>Split&hellip;</strong>, or <strong>Edit split&hellip;</strong> on one already split),
          from the <strong>Split (N)</strong> marker that a split row shows in its category column, or
          from the <strong>Split&hellip;</strong> button beside the category in the transaction detail
          panel. All three land in the same dialog.
        </p>
        <p>
          The split transaction editor reads as a small ledger &mdash; <em>Description</em>, <em>Category</em>, <em>Amount</em>,
          in the same order the transaction list uses. The description is optional and names what the portion
          is. Filling this in is useful as it is displayed when hovering over the
          transaction. <strong>+ Item</strong> adds another line. A split transaction needs at least two pieces.
        </p>
        <p>
          <strong>Remaining</strong> counts down as the amounts are filled in, and turns
          into <strong>Fully allocated</strong> when the items account for the transaction exactly.
          <strong> Save split</strong> stays unavailable until then.
          <strong> Add remainder to selected</strong> drops whatever is left into the amount last worked
          in -- useful for the final line -- and turns into an undo to reverse the operation if it went
          to the wrong part.
        </p>

        <h4>What the editor will not accept</h4>
        <ul>
          <li>
            <strong>The items must add up to the transaction.</strong>
          </li>
          <li>
            <strong>Every item points the same way as the transaction</strong> -- all money out, or all
            money in. A refunded item within a purchase is not currently expressible.
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
          editor opens with one line per item already filled in.
          Each item's list price differs from the item's share of the transaction, because a
          list price excludes tax, shipping and discounts. Those extra charges are
          <em>proportioned</em> across the items. <strong>Use items</strong> applies the proposal.
          Every field stays editable afterwards.
        </p>

        <h4>How a split transaction reads afterwards</h4>
        <p>
          In the transaction list the category column shows <strong>Split (N)</strong> in place of a
          category. Hovering it lists the items and their
          amounts; clicking it reopens the editor.
        </p>
        <p>
          The ledger shows the transaction <em>once</em>, at its full amount. Inside a report or a
          category drill-down it appears instead as the <em>item</em> that matched, at that
          item's amount. Opening the same transaction's detail panel shows the whole amount again. That
          difference is intended: one is the purchase, the other is the part of it that belongs to the
          category being looked at.
        </p>
        <p>
          Tags behave the way they read. A tag put on the transaction applies to the whole thing and to
          every item; a tag inherited from a category follows each item's own category, so a split
          transaction can contribute to multiple tag totals. See{' '}
          <HelpLink to="/help/tags">how tags work</HelpLink>.
        </p>

        <h4>Undoing it</h4>
        <p>
          <strong>Remove split</strong> returns the transaction to a single category -- the one it carried
          before it was split, which is kept for exactly this. Assigning a single category to a split row
          any other way is refused.
        </p>
        <p>
          Automatic categorization leaves a split alone. <strong>Categorize</strong> skips it, and
          even applying a rule to its matching transactions -- which otherwise overrides a category set by
          hand -- will not overwrite one, reporting how many it left instead.
          See{' '}<HelpLink to="/help/re-categorizing">what changes a transaction's category</HelpLink>.
        </p>
      </>
    ),
  },
  {
    id: 'multi-payment-purchases',
    section: 'transactions',
    title: 'One purchase paid in several payments',
    surfaces: ['Transactions (link marker, Bulk Edit)', 'Transaction detail (Purchase)'],
    summary: 'Some purchases are made with multiple payments and it may be interesting to link them together so the purchase price is accurate. Select the payments under Bulk Edit and choose Link as one purchase.',
    body: () => (
      <>
        <p>
          Some purchases are paid with multiple transactions such as a deposit up front and the balance on completion,
          or a few installments. This is aimed at purchases with a small number of payments, not something such as a loan.
          Each payment is a real movement of money on its own date. Linking them allows the ledger to record
          that they add up to one thing so the actual purchase price is clear.
        </p>

        <h4>Grouping the payments</h4>
        <p>
          On the Transactions page, turn on <strong>Bulk Edit</strong>, tick the payments that make up the
          purchase, and choose <strong>Link as one purchase</strong>.
          A name is optional, and is pre-filled from the payee when every payment has the same merchant name.
          The order or invoice number can be filled in if that is interesting and if the purchase is not complete,
          the eventual expected total can be added. Subsequent payments can be added later using the same process
          and selecting any of the existing payments to represent the multi-payment purchase along with the new
          payment(s) to add. The dialogue when <strong>Link as one purchase</strong> is pressed makes it clear
          what will happen.
        </p>

        <h4>Multi-payment purchases in the transaction report</h4>
        <p>
          Each payment which is part of a group carries a small <strong>&#128279;</strong> marker in its row. The hover
          text surfaces which payment of how many this is, what the purchase is called, and how much has been
          paid against what is expected. Clicking it opens the purchase.
        </p>
        <p>
          Where an expected total was recorded, the remaining balance shows
          as <strong>Unaccounted</strong>.
        </p>

        <h4>Modifying multi-payment purchases</h4>
        <ul>
          <li>
            <strong>A payment that turns up later</strong> joins the existing purchase rather than
            starting a second one: tick it together with any payment already in that purchase,
            and <strong>Link as one purchase</strong> adds it.
          </li>
          <li>
            <strong>A payment linked by mistake</strong> is removed by opening the purchase and
            using the <strong>&times;</strong> beside the incorrect payment.
            The transaction is untouched -- it simply stops
            counting toward the purchase. Removing one that would leave a single payment behind
            removes the purchase group.
          </li>
          <li>
            <strong>Ungroup this purchase</strong> undoes the grouping altogether.
          </li>
        </ul>

        <h4>Additional use cases</h4>
        <p>
          A refund against the purchase can be linked, and the total then reads as the net.
          If a transaction linked into a multi-payment purchase is sent to the trash, it stays
          listed on the payment record, struck through.
        </p>
        <p>
          Where a single payment covered two separate
          purchases, splitting that transaction across categories is the tool for it -- linking it to both
          would count the whole payment toward each.
        </p>
        <p>
          This is not intended for a payment that repeats indefinitely -- a subscription, a monthly bill,
          a mortgage -- <HelpLink to="/help/recurring-transactions">recurring series</HelpLink> is the way
          to manage that situation.
        </p>
      </>
    ),
  },
  {
    id: 'reimbursable-expenses',
    section: 'transactions',
    title: 'Reimbursable expenses',
    surfaces: ['Transactions (Reimbursements)', 'Transaction detail (Reimbursement)', 'Transactions (↩ marker)', 'Tasks'],
    summary: 'Concert tickets bought for friends, a work expense claimed afterwards. The reimbursable part goes into a category under the Reimbursable group, which keeps it out of spending totals. Linking the expense to the repayment tracks what is still owed; completing it closes the record and moves any difference into a real category. Anything outstanding longer than expected is raised on Tasks, so an expense that is never closed isn\'t excluded from totals indefinitely.',
    body: () => (
      <>
        <p>
          Some money leaves as an expense and comes back weeks or months later. Three concert tickets on
          one card charge with two of them bought for friends, a work expense paid personally and claimed
          afterwards, a medical expense submitted for insurance reimbursement, a group dinner where one person
          pays the bill and receives money from the others. These are all transactions that,
          at least partially, should not be counted against spending, nor should the repayment
          count against income.
        </p>
        <p>
          Tracking reimbursable expenses works by parking the part that is expected to be paid back in a category
          that is a member of the system's <em>Reimbursable</em> group.
          A system group, {' '}
          <strong>Reimbursable</strong>, sits alongside the other category groups and is excluded
          from totals, exactly as <strong>Transfers</strong> is. This group cannot be deleted although
          it can be renamed.
        </p>

        <h4>Creating categories</h4>
        <p>
          The <em>Reimbursable</em> group ships empty. A useful naming scheme for the categories is to
          indicate <em>what the money is for</em> -- Concert tickets, Work expenses, Health care expense, etc.
          Using "Reimbursable" as a prefix (Reimbursable work expenses) makes it easy to enter them when assigning
          categories.
        </p>
        <h4>Recording one</h4>
        <p>
          A wholly reimbursable expense is categorized straight into one of those categories. If the
          transaction is only partially reimbursable, one ticket kept, two bought for friends, {' '}
          <HelpLink to="/help/transaction-splits">split the transaction</HelpLink> and put the reimbursable
          portion in the reimbursable category and categorize the remainder. Splitting is also useful
          within the pieces in the reimbursable category when the expense belongs to multiple people:
          a group dinner for instance.
        </p>
        <p>
          The repayment, when it arrives, is categorized into the reimbursable category too. That is what
          keeps it out of income, and how it is located when linking expenses and payments.
        </p>

        <h4>Linking payments and expenses</h4>
        <p>
          Linking is about tying related payments and expenses together to support tracking
          how much is outstanding, whether it is overdue and for reporting the expenses and
          repayments together. It also allows for naming the transaction set.
        </p>
        <p>
          The <strong>Reimbursement</strong> button at the top of the Transaction screen launches a
          report containing the unsettled transactions in the reimbursable group and supports pairing
          expenses and repayments. Dragging a payment to an expense or an expense to a
          payment pairs them. Multiple items can be paired on one side or the other (e.g. there can be
          multiple payments for a single expense or multiple expenses for a single payment). Where a
          transaction is divided, the portions are offered as toggles and any combination can be chosen;
          several portions become one claim for their total.
        </p>
        <h4>Viewing outstanding reimbursements</h4>
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
          How long is "longer than expected" is set at the foot of the{' '}
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
          based on the account each transaction sits on. That way one person's outstanding expenses
          can be worked through without wading through another's. Every task is visible to
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
            records it as such. The button stays available but not emphasized, since a reimbursement with
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
          user's to add to, rename and remove. The group itself cannot be deleted, moved inside
          another group, or counted toward spending totals: each of those would either strand money owed
          back where nothing can find it, or silently restore the overstatement the group exists to
          remove.
        </p>
      </>
    ),
  },
  {
    id: 'transaction-documents',
    section: 'transactions',
    title: 'Attaching receipts and invoices',
    surfaces: ['Transactions (row marker)', 'Transaction detail (Documents)'],
    summary: 'Receipts and invoices can be attached to the transaction they belong to (dropped, browsed, or pasted straight out of an email), and text inside a PDF or a paste is searchable from the ordinary filter box. Images can be added but do not provide searchable text.',
    body: () => (
      <>
        <p>
          For some transactions it can be useful to attach supporting documents. This could be to
          provide additional detail for a large expense or it could be just to store the receipt where it
          can be easily located later.
        </p>
        <p>
          Attachments live on the transaction detail panel under <strong>Documents</strong>, and a row
          that carries any shows a paperclip marker which opens them. Multiple documents can be attached
          to a single transaction.
        </p>

        <h4>Attaching a document</h4>
        <p>
          In the transaction editor there is a Documents section with two controls to attach files and text.
          One control is a file browser/file drop target and the other is for pasting the contents of the
          clipboard. Either control accepts the same kinds of document; which one to use depends on where
          the document is coming from. For plain text, pasting it from the clipboard allows it to be edited
          before it is stored.
        </p>
        <ul>
          <li>
            <strong>Paste an image</strong> -- a screenshot in a file, or a photo already on the clipboard.
          </li>
          <li>
            <strong>Paste text</strong> from the clipboard. For emailed receipts it is often easier to
            use copy/paste rather than saving the email as a file. The pasted text can be edited before it
            is saved if there is extraneous information to remove.
          </li>
          <li>
            <strong>Attach a file</strong> -- the file-system browser and file drop zone add files already
            on disk.
          </li>
        </ul>
        <p>
          An unedited paste keeps the layout it came with. The plain-text flavor of a copied email is its
          table flattened, one cell to a line, so an amount ends up under the item it prices rather than
          beside it; keeping the original markup preserves the arrangement the sender laid out. Editing
          the box turns that off, since an edit says the text on screen is what was wanted. The panel
          states which of the two will be stored.
        </p>

        <h4>What is accepted, and scaling</h4>
        <p>
          PDFs, images, plain text, and saved email.
          Large photographs are scaled down -- a receipt shot at twelve megapixels carries
          nothing legible above roughly 300 DPI -- and
          the original is not kept. Screenshots and small images pass through untouched.
          A generous per-file size limit exists to stop
          a pathological scan, not to ration space.
        </p>
        <p>
          Attaching the same file to the same transaction twice is reported rather than stored twice.
        </p>

        <h4>Searching what is inside</h4>
        <p>
          Text is available for a PDF carrying a text layer, for an <code>.eml</code> file, and for
          anything pasted or uploaded as text. There is no OCR facility so
          text cannot be extracted from a <em>photograph</em> of a receipt. Pictures are
          stored and viewable, but not findable by the contents.
        </p>
        <p>
          Text found in an attachment is searched by the ordinary quick-filter box on the Transactions
          page. A transaction whose match came from an attachment is flagged so it is clear why
          it was matched even though the search term is not present in the visible fields.
          Typing <code>doc:</code> before the terms narrows a search to attachments only. See{' '}
          <HelpLink to="/help/searching-transactions">searching by date or amount</HelpLink> for the rest
          of that box.
        </p>

        <h4>Removing, the trash, and backups</h4>
        <p>
          Documents follow their transaction into the trash and come
          back intact if the transaction is restored from the trash. When the trash is emptied, any associated
          documents are destroyed (deleted off disk).
        </p>
        <p>
          Attached files are stored as individual files on disk rather than inside the database. They
          travel inside the <strong>Financial data</strong> backup along with the transactions that
          reference them -- so a backup taken after attaching a receipt contains the receipt. See{' '}
          <HelpLink to="/help/data-and-backups">data on disk, and backups</HelpLink>.
        </p>
      </>
    ),
  },
  {
    id: 'page-categories',
    section: 'categories',
    title: 'Categories and groups',
    surfaces: ['Categories'],
    summary: 'Categories are assigned to transactions and collected into groups, which is what the dashboard reports on. Groups carry a few behaviors of their own, and three of them are supplied by the system.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          The category tree has two levels. A <strong>group</strong> collects related categories, and
          a <strong>category</strong> is what a transaction is actually assigned to. A transaction is
          never assigned to a group directly. Reports roll categories up into their group, so the
          grouping is what decides how the dashboard reads.
        </p>
        <p>
          Categories are created, renamed and moved here, and the right-hand panel
          holds <HelpLink to="/help/categories-tags">the tags on the selected category or
            group</HelpLink>. Deleting a category asks what should happen to the transactions in it,
          and a deleted category moves to the <strong>Inactive</strong> list at the foot of the page
          rather than disappearing. <strong>Delete empty</strong> clears categories nothing refers to,
          after listing exactly what would go.
        </p>
        <p>
          Categories are optional. The transactions stay searchable without them, and the seed set of
          groups is there to be used or ignored.
        </p>
        <h4>The system groups</h4>
        <p>Three groups are supplied rather than created, because features depend on them.</p>
        <ul>
          <li>
            <strong>Unassigned</strong> holds imported categories that have not been sorted into a
            reporting group yet. It cannot be renamed or deleted,
            and <HelpLink to="/help/imported-category-cleanup">Group imported categories</HelpLink> is
            the workspace for emptying it.
          </li>
          <li>
            <strong>Transfers</strong> is where money movement is filed, and ships
            with <HelpLink to="/help/exclude-from-totals">Exclude from totals</HelpLink> turned on.
            Imports file their own money-movement rows into it, so it cannot be deleted or moved
            inside another group. It can be renamed, and its exclusion can be turned off.
          </li>
          <li>
            <strong>Reimbursable</strong> holds <HelpLink to="/help/reimbursable-expenses">money
              expected to be paid back</HelpLink>. It cannot be deleted or moved either, and unlike
            Transfers its exclusion cannot be turned off: the outstanding balance is only meaningful
            while that money sits outside the totals.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'exclude-from-totals',
    section: 'categories',
    title: 'Excluding a group from totals',
    surfaces: ['Categories (group settings)'],
    summary: '"Exclude from totals" is used to keep money movement (credit-card payments, transfers between accounts, reimbursable expenses) out of income and spending totals.',
    body: () => (
      <>
        <p>
          <strong>Exclude from totals</strong> removes a category group and the categories under
          it from the dashboard's charts and totals. It is a reporting switch, not a delete:
          the transactions still exist and stay searchable, they just don't count toward the
          spending or income figures.
        </p>
        <p>
          One use case is for <strong>money movement that isn't spending or income</strong>. Bringing in
          data from both a credit card account and a bank account brings in both the payments for each of the
          credit card transactions as well as the payment from the bank account to pay off the credit card (and the
          crediting of that payment on the credit card side).
        </p><p>
          Another use case is for transfers between accounts. If money is kept in some high(er) yielding
          account and transferred in to cover spending periodically, it probably should not be counted as spending or
          income. Likewise, if money is moved from a checking account to a savings account, while that might be
          interesting, it also shouldn't be counted. P2P account transfers may also fall into this
          category.
        </p><p>

          Assigning those <strong>credit-card payments</strong> and <strong>transfers
            between accounts</strong> to a category in a group excluded from the totals keeps the ledger clean. Often a
          surprising spending level or imbalance in income/expenses can be attributed to something not being
          excluded from the total that should have been.
        </p>
        <p>
          The system-supplied <strong>Transfers</strong> group ships with this turned on, so
          either use the pre-built categories under it, or create new categories, and use them for
          credit-card payments and account-to-account transfers. The switch works on
          any group, and can be disabled on <strong>Transfers</strong> if desired.
        </p>
        <p>
          The built-in <strong>Reimbursable</strong> group is also excluded from totals. This cannot
          be turned off for this group. This is used as part
          of <HelpLink to="/help/reimbursable-expenses">the reimbursable expense workflow</HelpLink>.
        </p>

      </>
    ),
  },
  {
    id: 'tags',
    section: 'categories',
    title: 'How tags work',
    surfaces: ['Tag manager (Settings)'],
    summary: "Tags are cross-cutting labels applied at the transaction, category, group, or account level. A transaction's effective tags are the union of all four sources.",
    body: () => (
      <>
        <p>
          Tags are lightweight labels separate from the category tree. Use them for any cross-cutting
          dimension to report by &mdash; <em>Essential</em> vs everything else, who an
          expense belongs to in a household, business vs personal, vacation buckets, and so on. Tags can also be
          used as placeholders to build complicated expressions which cannot be expressed in the filter.
        </p>
        <p>
          A tag can be attached at four levels, and a transaction's <strong>effective
            tags</strong> are the additive union of all four:
        </p>
        <ul>
          <li><strong>Direct (transaction-level)</strong> &mdash; added by a matching rule, or by
            manually editing one transaction. Manual edits override the rule for that one row.</li>
          <li><strong>Category-level</strong> &mdash; a tag attached to a leaf category propagates
            to every transaction in that category.</li>
          <li><strong>Group-level</strong> &mdash; a tag attached to a category group propagates to
            every transaction in any of the group's leaves.</li>
          <li><strong>Account-level</strong> &mdash; a tag attached to an account (on the Accounts
            page) propagates to every transaction in that account. For a merged account the top-level
            account's tags carry to its child accounts' transactions, while a merged child's own tags
            stay dormant until it is detached.</li>
        </ul>
        <p>
          Pick the level that matches the intent. A tag like <em>Bills</em> probably belongs on a
          group although if it is only on a single group, there may not be any need for it.
          A tag such as <em>Essential Expense</em> may get applied to several categories, or even individual
          transactions which may fall into a category which is not one that is marked. Composing across
          levels is fine &mdash; the same tag can be on a group, an account and on individual transactions. The
          expectation is that a tag is on more than one thing, and/or is generated by one or more rules.
        </p>
        <p>
          To hide an inherited tag on a single transaction, uncheck it in that transaction's tag
          picker (the row's tag popover or the transaction editor). It stays on every other
          transaction that inherits it, and a strike-through <em>hidden here</em> entry in the picker
          can be checked to restore it. Removing the tag from the category, group, or account drops
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
    section: 'categories',
    title: 'Tagging categories and groups',
    surfaces: ['Categories page right panel'],
    summary: 'Attach tags to a category or group from its right panel on the Categories page. Tags on a group propagate to every category under it; tags on a category apply just to that category.',
    body: () => (
      <>
        <p>
          The right-hand panel on the Categories page shows the selected category's tags as
          pills. Click <strong>+ Tag</strong> to attach a new one.
        </p>
        <p>
          When a leaf category is selected, the assigned tags are displayed as well as
          any <em>inherited</em> tags from the group. Inherited tags are displayed in italics and do
          not have a remove button. To remove an <em>inherited</em> tag,
          remove the tag from the group. There is no way to block an inherited tag on one of the group's categories.
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
    id: 'imported-category-cleanup',
    section: 'categories',
    title: 'Learning categories from imported transactions',
    surfaces: ['Group Imported Categories', 'Categories page'],
    summary: 'Workspace for organizing categories imported from transactions into groups and removing any which are no longer wanted.',
    body: () => (
      <>
        <p>
          The <strong>Group Imported Categories</strong> workspace displays the categories "learned" from
          imported transactions. The imported categories can be placed into groups or deleted if they are
          no longer interesting.
        </p>
        <p>
          Deleting a category removes it from the existing imported transactions (the categories are
          learned from transactions which were imported with their categorization) and will be
          removed from future imports as well. A deleted category moves to the <strong>Inactive</strong> list at the
          bottom of the Categories page, where <strong>Recover</strong> restores it to the
          group it was deleted from, or Unassigned if that group is gone.
        </p>
        <p>
          Pending imported categories can also be placed in the <strong>Set aside</strong> list.
          This moves them out of the "needs sorting" pool but leaves the category active. They appear
          in the Unassigned category. Use this for "I've triaged this."
        </p>
      </>
    ),
  },
  {
    id: 'page-rules',
    section: 'rules',
    title: 'The Rules page',
    surfaces: ['Rules'],
    summary: 'A rule matches incoming transactions and acts on them, setting a merchant name, a category, tags, or marking them part of a recurring series. Most rules are created while categorizing rather than written here.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          A rule has <strong>conditions</strong> that select the transactions it applies to
          and <strong>actions</strong> to take on them. Conditions are a keyword together with
          optional owner, account, account-type and amount limits. Actions set a merchant name,
          assign a category or tags, or mark the matches as part of a recurring series. Rules run
          against newly imported data, which is what keeps categorization current without repeating
          the work.
        </p>
        <HelpHeading anchor="how-rules-come-into-being">How rules come into being</HelpHeading>
        <p>
          There are three main ways rules get created:
        </p>
        <ol>
          <li>
            Importing data from another tool where the transactions have already been carefully categorized, indicate
            when importing that the data is clean and the categories will be preserved and imported for use;
            the <strong><HelpLink to="/help/generate-rules">Generate rules</HelpLink></strong> action studies
            these curated transactions and proposes rules that would reproduce the same categorization on
            future, uncategorized data -- which get reviewed before anything takes effect.
          </li>
          <li>
            When a transaction is categorized, {APP_NAME} offers to
            turn that action into a rule -- give it conditions and actions, apply it to other matching
            transactions, and save it. From then on it runs automatically against newly imported data.
          </li>
          <li>
            When a transaction is marked as part of a recurring series the way that happens is through the
            Rules editor so the Rules editor is launched filled out with whatever information is available.
          </li>
        </ol>
        <p>
          If starting fresh with no curated data, there is a small <strong>starter
            set</strong> of common categories and rules that can be added via buttons on the Rules and Category pages.
          Rules alter the data, so the starter rules are shown as a list for approval before adding.
        </p>
        <HelpHeading anchor="applying-rules">Applying rules, and checking them</HelpHeading>
        <p>
          <strong>Categorize</strong> re-applies every rule across the ledger, changing only rows that
          are not pinned, so work done by hand is left
          alone. <HelpLink to="/help/re-categorizing">What changes a transaction's category</HelpLink> covers
          which rows each action is allowed to touch.
        </p>
        <p>
          <strong>Rule checkup</strong> reports rules that compete with each other and charges that
          have drifted outside a rule's amount range. It changes nothing on its own, and carries a
          count when there is anything to look at.
        </p>
      </>
    ),
  },
  {
    id: 're-categorizing',
    section: 'rules',
    title: "What changes a transaction's category",
    surfaces: ['Rules page'],
    summary: 'Categorize re-applies rules but never disturbs a category set by hand or kept from a trusted import; applying a rule to its matching transactions is full-force and overrides them. A closing section ranks the categorization sources for anyone who wants the full model.',
    body: () => (
      <>
        <p>
          A transaction's category can come from a few different places, and the two bulk actions that
          re-categorize -- <strong>Categorize</strong> and a rule's <strong>apply to matching
            transactions</strong> -- treat those origins differently. The practical effect of each is
          below; a closing section ranks the sources in full for anyone who wants it.
        </p>
        <h4>Categorize</h4>
        <p>
          The <strong>Categorize</strong> button (on the Rules page) re-applies every rule
          across the whole ledger, but only to rows that are <strong>not pinned</strong> -- those
          categorized by a rule, and those still uncategorized. It deliberately leaves alone anything
          categorized <em>by hand</em> or kept from a <em>trusted import</em>. It only ever <em>sets</em>
          or <em>changes</em> a category, never removes one: a rule-assigned row that no longer matches
          any rule <strong>keeps</strong> its category, so deleting or narrowing a rule doesn't
          silently un-categorize the transactions it already handled. It is the pass to run after adding
          or changing rules, to refresh categorization without disturbing earlier work.
        </p>
        <p>
          To deliberately <em>undo</em> a rule's categorizations -- when a rule was wrong -- use the{' '}
          <em>re-evaluate this rule's transactions</em> option offered when you delete or edit a
          rule. It re-runs just those rows against the remaining rules, so they fall to another matching
          rule or to uncategorized, rather than keeping the removed rule's category.
        </p>
        <h4>Apply a rule to its matching transactions</h4>
        <p>
          When a rule is saved -- for example from the toast offered after categorizing a transaction --
          it offers to apply to every transaction its matcher catches: the keyword together with any
          owner, account, or amount limits. This apply is <strong>full force</strong>. It claims all
          matching rows and sets them to the rule's category, <strong>including rows categorized by hand
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
          <li><strong>Rule</strong> -- assigned by a matching rule. Not pinned, so Categorize
            re-evaluates it (it can move to another rule, but is never cleared) and a full-force apply
            overwrites it; it is reverted only by the opt-in <em>re-evaluate</em> when the rule is deleted
            or edited.</li>
          <li><strong>Uncategorized</strong> -- no category yet; any rule is free to claim it. (A row whose
            imported category was <em>cleared</em> when a suggested rule was rejected sits here too: rules
            can categorize it, but the discarded file label is kept on the row and never re-applied.)</li>
        </ul>
        <p>
          The asymmetry is the part to remember: <strong>Categorize</strong> respects the two
          protected origins, while a rule's <strong>apply to matching</strong> does not.
        </p>
        <p>
          One deliberate exception lives on the{' '}
          <HelpLink to="/help/generate-rules">Generate-rules conflict screen</HelpLink>:
          re-categorizing a row there corrects the file's category and the row <em>keeps</em> its
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
          To check a single transaction's current source, open its detail panel: a small pinned label
          sits beside the category, and the details show a <em>Categorized by</em> line naming the
          source -- a rule, a manual edit, or the category present in the source data.
        </p>
      </>
    ),
  },
  {
    id: 'rule-precedence',
    section: 'rules',
    title: 'When two rules match the same transaction',
    surfaces: ['Rules page'],
    summary: 'Rules are not ranked manually; there is an internal ranking that puts scope first, then keyword length, then the narrower amount range. There are ambiguous situations which require decisions and the Rules checkup lists them: amount ranges that overlap without one containing the other, which requires refining the conditions, and merchant names where one contains the other, which is fine but does not always resolve the way it reads. Rule checkup also identifies rules which are essentially duplicates of each other where one can be deleted outright.',
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
          over $300, so it wins wherever both apply -- which is what makes a single biller's
          several bills separable by size, one rule per band.
        </p>
        <h4>Checking for rules that compete</h4>
        <p>
          <strong>Rule checkup</strong> on the Rules page lists the pairs which overlap.
          Running the check changes nothing on its own; it opens a report with what it
          found, and each rule can be opened for editing from there. The report also lists{' '}
          <HelpLink to="/help/rule-amount-drift">charges that have drifted out of a rule's range</HelpLink>.
        </p>
        <p>
          Rule checkup reports:
        </p>
        <ul>
          <li>
            <strong>Amount ranges that overlap</strong> -- two rules for the same merchant whose ranges
            cross without one sitting inside the other, such as $300 to $4,000 against $3,000 and up. A
            $3,500 charge matches both and neither rule is the more specific one, so which of them wins
            is arbitrary. The way to settle this is to refine the conditions so they do not overlap.
          </li>
          <li>
            <strong>Merchant criteria that nest</strong> -- one rule's keyword contained in
            another's, such as <em>northgate</em> and <em>northgate prime</em>. Nothing is wrong
            here, and it is listed only so the outcome is visible: usually the longer keyword wins, but
            because scope is settled first, a short keyword scoped to an owner or an account matches transactions
            that otherwise would be matched to the longer keyword.
          </li>
          <li>
            <strong>A nesting pair can also be surplus.</strong> Where both rules file to the same
            category and carry the same owner, account and debit/credit limits, the narrower one changes
            nothing -- the broader rule would file those transactions identically, so the finding
            offers to <strong>delete</strong> it, recoverable from the rules trash. The offer appears on
            the narrower rule alone. Where the two differ in a rename or a tag,
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
          <strong>Overlapping amount ranges cannot be dismissed.</strong> An overlap means it is
          genuinely undecided which of the two rules
          applies to a charge in the shared band, and no acknowledgement makes that decided. These stay
          listed until the conditions are refined.
        </p>
        <p>
          Ranges where one sits entirely inside the other are deliberately not reported. That case has a
          clear answer already -- the inner range wins -- and it is the recommended way to split one
          merchant's charges across categories.
        </p>
      </>
    ),
  },
  {
    id: 'rule-amount-drift',
    section: 'rules',
    title: 'When a bill outgrows its rule',
    surfaces: ['Rules page'],
    summary: 'An amount range decides which transactions a rule claims, so a bill that grows past the limit stops being categorized by that rule and drops out of any series the rule feeds, with nothing appearing to go wrong. Rule checkup reports the recent charges this has happened to, and offers to adjust the limit.',
    body: () => (
      <>
        <p>
          An amount range on a rule is a <strong>matching gate</strong>, not a preference: a charge
          outside it is not claimed by that rule at all. That is what makes a single biller's
          several bills separable by size, and it is also what makes a drifting bill easy to miss. When a
          water bill that has always come in under $60 arrives at $63, the rule stops matching it. The
          charge keeps whatever category it would have had without the rule -- often none -- and it drops
          out of any recurring series the rule feeds, because a series claims the transactions its rule
          claims. Nothing malfunctions, so nothing announces it, although a recurring series may raise a flag
          about a missed expected charge.
        </p>
        <p>
          <strong>Rule checkup</strong> on the Rules page reports these. The button carries a count when
          there are any, and the panel lists each charge with the related rule, how far outside the
          limit it landed, and where it ended up instead. Only recent charges are listed, and only ones
          that missed by a little: a charge at three times the limit is a different bill and does not
          trigger a notification.
        </p>
        <p>
          Actions available for each reported charge are:
        </p>
        <ul>
          <li>
            <strong>Widen to include</strong> moves the limit out to the charge and re-applies the
            rule. Categorizations made by hand are left alone. The series
            follows on its own: once the row carries the rule's category again, the next scan takes
            it back into the series.
          </li>
          <li>
            <strong>Edit</strong> opens the rule itself, for the times the range is not what wants
            changing or the adjustment should be larger than suggested.
          </li>
          <li>
            <strong>Dismiss</strong> acknowledges one charge without touching the rule, for a charge the
            rule was not meant to claim. It covers that charge alone; another charge of the same amount
            would raise the exception again. Create a new rule if there are repeated expected charges close
            to the edge of the existing range.
          </li>
        </ul>
        <p>
          A charge that is <em>inside</em> the range but close to a limit is reported the same way, more
          quietly -- the same warning one occurrence earlier, with no offer to widen, since the rule is
          still claiming it.
        </p>
      </>
    ),
  },
  {
    id: 'generate-rules',
    section: 'rules',
    title: 'Generating rules from transactions in an imported file',
    surfaces: ['Import / Export (rule suggestions)'],
    summary: 'Generate rules studies a file whose transactions are already categorized and proposes rules that reproduce that categorization on future data; the output is rules, not a re-categorization of the file. When one merchant is filed under several categories the suggestions form a conflict set, which can be resolved in different ways for different results.',
    body: () => (
      <>
        <p>
          If the data comes from another tool where the transactions already carry meaningful categories,
          tell {APP_NAME} the import's category data is useful (turn on <em>"use the categories present in the data"</em>
          on the file's card). {APP_NAME} keeps that categorization on the imported transactions, adds new categories to
          the pool of categories to be grouped by <strong>Group Imported Categories</strong>, and <strong>Generate rules</strong> analyzes them to propose rules that reproduce the
          same categorization on future, uncategorized data.
        </p>
        <p>
          The output of <strong>Generate rules</strong> is rules, not a
          re-categorization of the file; the imported rows are already categorized.
          The goal is to capture the <em>pattern</em> so future imports categorize themselves.
          That said, two things on this screen do still change the underlying rows.
        </p>
        <ol type="a">
          <li>
            Accepting a suggestion applies its rule to exactly the rows that generated it, so an edit
            made to the rule before accepting it (a tweaked category, added tags, a rename) lands on those
            rows too, and they shift from import-locked to
            rule-governed (see{' '} <HelpLink to="/help/re-categorizing">what changes a transaction's category</HelpLink>).
          </li>
          <li>
            Resolving a conflict has various options to re-categorize rows.
          </li>
        </ol>
        <p>Available actions for each suggested rule:</p>
        <ul>
          <li><strong>Save</strong> it (optionally after editing its keyword, category, owner/account
            scope, amount range, rename, or tags),</li>
          <li><strong>Defer</strong> it to decide later, or</li>
          <li><strong>Discard</strong> -- reject the proposed rule. The two buttons
            under <em>discard and&hellip;</em> choose what happens to the rows it covered:
            <ul>
              <li>
                <em>keep categorization</em> leaves them exactly as imported -- the file's category
                sticks as a settled decision, and is still reclaimable later if a
                matching rule is created and applied. This is the choice for a genuine exception (an annual fee
                filed under its own category).
              </li>
              <li>
                <em>remove categorization</em> clears the category
                instead, freeing the rows for rules to categorize later (the discarded file label is kept on
                the row but is never re-applied). This is for a file category that was wrong or messy.
              </li>
            </ul>
          </li>
        </ul>
        <h4>Conflict sets, and the different ways to resolve them</h4>
        <p>
          When the same merchant was filed under <strong>several different categories</strong>, a single
          rule cannot reproduce all of them, so those suggestions are grouped into
          a <strong>conflict set</strong>. Open the set to see the competing categories and the matching
          rows. The resolution chosen determines the result:
        </p>
        <ul>
          <li><strong>Narrow the rules so they no longer overlap.</strong> Add a distinguishing filter
            (owner, account, or amount) to each rule so each claims its own subset, keeping more than
            one rule for the merchant.</li>
          <li><strong>Pick one category for the merchant and re-categorize the rest.</strong> The
            matching-transactions viewer can set the majority category in bulk to collapse the conflict
            to a single rule. Re-categorizing here <em>corrects the file's category</em>, and the rows
            keep their trusted-import weight, so they keep informing the suggestions.</li>
          <li><strong>Keep an outlier as a one-off.</strong> <strong>Preserve</strong> a genuinely
            distinct row to record it as a manual exception: rules leave it alone and it drops out of
            the suggestions entirely, rather than re-surfacing as a conflict.</li>
        </ul>
        <p>
          The last two produce subtly different results: a bulk re-categorize
          keeps rows in the import learning set and re-targets the rule, while Preserve carves a
          row out as an untouchable manual decision. How those properties affect subsequent behavior is covered
          in <HelpLink to="/help/re-categorizing">what changes a transaction's category</HelpLink>.
        </p>
        <h4>Older suggestions, and clearing them out in bulk</h4>
        <p>
          Rules are forward-looking, so a merchant pattern with no recent activity is unlikely to recur.
          As an aid when importing older transaction history, suggested rules whose newest matching transaction
          falls outside the <em>Look back</em> window move
          off the main <em>pending</em> list onto a separate <em>older</em> pill, so the pending count
          reflects only patterns that are still live. Nothing is lost -- widening the look-back window
          brings them back, and the underlying rows are untouched by the lens itself.
        </p>
        <p>
          Because older suggestions are already out of the way, settling them is optional -- a stale tail
          can simply be left alone. Alternatively, open the <em>older</em> pill, select several
          rows at once, and apply a bulk disposition:
        </p>
        <ul>
          <li><em>Discard, keep categories</em> marks them
            reviewed while leaving their rows exactly as imported (for a pattern not
            worth a rule)
          </li>
          <li>
            <em>Discard, clear categories</em> additionally clears those rows so future rules may categorize them
          </li>
        </ul>
        <p>
          Both choices have the same effect on the row's import state as the single-suggestion <strong>Discard</strong>.
        </p>
        <p>
          See also:{' '}
          <HelpLink to="/help/page-rules#how-rules-come-into-being">how rules come into being</HelpLink>.
        </p>
      </>
    ),
  },
  {
    id: 'page-accounts',
    section: 'accounts',
    title: 'Accounts and owners',
    surfaces: ['Accounts'],
    summary: 'Accounts are where transactions come from, and owners attribute them to a person for filtering and reports. The page has three tabs: Accounts, Owners and Connections.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          <strong>Accounts</strong> are created by importing rather than set up in advance: a file or
          a data source is mapped to an account, and the account appears. An account can matter on its
          own, such as a card used for one purpose, or as the way a transaction is attributed to an
          owner. A tag attached to an account reaches every transaction on it.
        </p>
        <p>
          Two accounts that turn out to be the same physical account can
          be <HelpLink to="/help/merging-accounts">merged</HelpLink>, which also settles the
          duplicates between them. Detaching reverses it.
        </p>
        <p>
          <strong>Owners</strong> are created on the second tab and assigned to accounts. Once more
          than one owner exists, <em>shared</em> becomes available as a choice. Owner can be filtered
          and reported on, and a rule can be scoped to one.
        </p>
        <p>
          <strong>Connections</strong> is where a data provider is linked and the accounts it offers
          are mapped to accounts here. A connection that needs attention says so on its card and on
          the Tasks page.
        </p>
      </>
    ),
  },
  {
    id: 'merging-accounts',
    section: 'accounts',
    title: 'Merging accounts to reconcile',
    surfaces: ['Accounts page'],
    summary: "Merging two accounts that represent the same physical account auto-confirms the overlaps both sources describe identically; order doesn't matter and detaching reverses it.",
    body: () => (
      <>
        <p>
          Merging two accounts on the Accounts page means <strong>"these are the same physical
            account."</strong> When they genuinely are, merging <strong>auto-confirms the overlaps both
              sources describe identically</strong>; a pair the two sources worded differently stays in
          review. The order is irrelevant: <em>importing then merging</em> and
          <em> merging then importing</em> reach the same state. <strong>Detaching</strong> an account
          reverses the merge's auto-confirmations &mdash; your explicit Reject / Replace decisions are kept.
        </p>
      </>
    ),
  },
  {
    id: 'recurring-transactions',
    section: 'recurring',
    title: 'Recurring transactions',
    surfaces: ['Recurring', 'Rules (recurring series)', 'Transactions (row menu)'],
    summary: 'A recurring series tracks a transaction that repeats on a schedule. Many are found automatically by looking for similar looking transactions on a fixed schedule. Recurring transactions the scan misses can be identified by creating a Rule. Per-transaction overrides exist for the exceptions. Alerts are generated if a recurring transaction is missing or changes.',
    body: () => (
      <>
        <p>
          A <strong>recurring series</strong> is a transaction that repeats on a schedule -- a subscription, a
          bill, a paycheck. These may have a fixed amount or the amount may vary in a range.
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
          to create rules that generate a single name for a payee, rules can also declare that their
          matching transactions form a series. Turn on this flag and every transaction the rule matches
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
          not a hand-kept list.
        </p>
        <ul>
          <li>
            <strong>Remove from the series</strong> -- for a transaction the scan swept in by mistake. It stays
            out across future scans. A removal is reversible: undo it from the prompt, from the removed
            transaction's own right-click menu (<em>Restore to recurring series</em>), or from
            the <em>removed</em> list inside the series.
          </li>
        </ul>
        <p>
          There is no way to force a transaction into a series it does not match. A series is
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

        <h4>Transfers between two accounts</h4>
        <p>
          A transfer -- or a credit-card payment -- moves money between two accounts. If both accounts
          are tracked, it arrives as two transactions. The scan matches the two transactions and treats the
          movement as a single transaction naming both accounts.
        </p>
        <p>
          These pairs are found by matching the amounts -- same amount, opposite directions, within a few days
          -- rather than by name. Two institutions often describe one payment quite differently, and
          those descriptions can change over the years; matching on the money means a payment made monthly
          for a decade stays one series no matter how its wording drifted. A transfer with only one side
          on the books, because the other account is not tracked here, is an ordinary series.
        </p>
        <p>
          A matched-up transfer takes over its own transactions, even where those transactions already
          sit in a series matched by name -- one payment recorded twice is still one payment, and the
          name is the part that drifts. Nothing is deleted by this: a series that also covers charges
          outside the transfer keeps those charges. The exception is a series backed by a rule, which
          keeps everything its rule names.
        </p>
        <p>
          One situation stops a transfer being matched up, and it is listed
          under <em>Transfer &amp; payment review</em> on the Recurring page: where more than one
          transaction matches equally well, nothing is paired at all, because the data does not say
          which is the other half. Choosing the right one there settles it, and the answer is remembered.
        </p>
        <p>
          The suggestion can be rejected as well as answered. Dismissing an unmatched transfer leaves it
          matched by merchant name, as before. Dismissed items drop off the list and collect at the foot
          of the panel, where they can be undone.
        </p>

        <h4>What needs attention</h4>
        <p>
          The Recurring page has three views, chosen from the selector under its title: the
          <em> Series</em> list itself, <em>Needs attention</em>, and <em>Upcoming</em>. The count beside
          <em> Needs attention</em> is how many findings are open.
        </p>
        <ul>
          <li>
            <strong>Missing charge</strong> -- an occurrence is overdue. Lateness is
            measured against how current the data is rather than against the calendar.
            After a couple of missed cycles the series is treated as probably canceled, and
            <em> Mark ended</em> is offered as an option. Nothing is ended automatically.
          </li>
          <li>
            <strong>Amount changed</strong> -- a charge that came in slightly out of range of what the series has been
            charging. A series with a steady price reports a modest step; one that moves every month
            reports only a charge beyond anything it has done before. Once a second charge arrives at the
            new price the change is treated as the new normal and stops being reported.
          </li>
          <li>
            <strong>Newly detected</strong> -- a series found for the first time in the last month.
          </li>
        </ul>
        <p>
          Opening the <em>series report</em> on a finding opens the related transactions in a panel below the
          findings, without leaving the list being worked through.
        </p>
        <p>
          Dismissing a finding covers that one
          finding only -- a later missed cycle, or a different charge, is reported again. Anything
          dismissed stays listed at the foot of the section and can be brought back.
        </p>
        <p>
          On a bill whose amount moves -- gas, electricity, water -- dismissing an amount also
          <strong> extends the range</strong>. A heating bill that peaks every January generates an
          alert the first winter, and dismissing it keeps the ones after from alerting;
          the later charges up to the amounts already accepted pass without comment, while a charge beyond
          them generates a new alert. Restoring a dismissal restores the prior range. Fixed-price
          subscriptions work differently on purpose -- there a dismissal means the price rose, and the
          next increase is still reported.
        </p>

        <h4>What is coming up</h4>
        <p>
          The <em>Upcoming</em> view lists the charges due in the next month with what they are expected
          to cost. Nothing there is wrong, so it carries no actions, no dismissal, and never
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
          <HelpLink to="/help/page-rules#how-rules-come-into-being">how rules come into being</HelpLink> and{' '}
          <HelpLink to="/help/re-categorizing">what changes a transaction's category</HelpLink>.
        </p>
      </>
    ),
  },
  {
    id: 'page-import-export',
    section: 'importing',
    title: 'The Import / Export page',
    surfaces: ['Import / Export'],
    summary: 'Where transactions come in and where data goes out. Four tabs cover Import, Export, Backup / Restore and Amazon, and the import history below keeps a card per file recording what it did.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          <strong>Import</strong> is the CSV importer. A file is dropped on it or browsed to, and a
          mapping screen follows: which column holds the date, the amount and the
          description, <HelpLink to="/help/amount-conventions">how the file represents money in and
            out</HelpLink>, and which account the rows belong to. Saving those settings as
          a <HelpLink to="/help/unknown-data-source">data source</HelpLink> means the next file from
          the same place needs none of it again.
        </p>
        <p>
          <strong>Amazon</strong> has its own tab because marketplace orders arrive in their own shape
          and are matched against charges already in the ledger:
          see <HelpLink to="/help/amazon-import">importing Amazon order detail</HelpLink>.
          <strong> Export</strong> writes transactions out as CSV,
          and <strong>Backup / Restore</strong> handles
          the <HelpLink to="/help/data-and-backups">whole-database archives</HelpLink>.
        </p>
        <p>
          Importing the same activity twice is safe. Every import is compared against what is already
          in the ledger and the clear duplicates are settled without
          asking; <HelpLink to="/help/duplicate-report">the duplicate-detection report</HelpLink> on
          the file card holds whatever needs a decision.
        </p>
        <p>
          Each imported file gets a <strong>card</strong> in the import history, grouped by data
          source. The card carries pills for what the import did and what still needs attention, a
          link to the transactions it created, and <strong>Undo</strong>, which removes the import
          along with everything it changed.
        </p>
      </>
    ),
  },
  {
    id: 'unknown-data-source',
    section: 'importing',
    title: 'Saved data sources (import file profiles)',
    surfaces: ['Import / Export (Recent imports)'],
    summary: 'Imported files not linked to a saved mapping are listed under "unknown data source" or "temporary draft". A data source is a saved mapping which is useful if other files with the same format (e.g. from the same source) will be imported later.',
    body: () => (
      <>
        <p>
          A <strong>data source</strong> is a saved template of the settings from the
          import mapping screen describing the fields and account mapping. Imported files
          are organized in the import history section by data source. If there will be future
          imports from the same data source it is useful to save the mapping so it does not
          need to be recreated each time. A file lands under <strong>unknown data source</strong> or a <strong>temporary
            draft</strong> when it isn't linked to a data source.
        </p>
        <p>
          The saved mapping can be created during the import or afterwards from
          the import summary on the import/export page.
        </p>
        <p>
          The <strong>Manage sources</strong> button allows for editing, deleting and can also
          be used to create new data sources. Deleting a data source does not remove any files,
          just the mapping template.
        </p>
      </>
    ),
  },
  {
    id: 'amount-conventions',
    section: 'importing',
    title: 'Specifying how amounts are represented',
    surfaces: ['Import mapping', 'Data source editor'],
    summary: 'Specify how the file represents money in vs out: a single signed column, an amount column plus a separate debit/credit "type" column, or separate debit and credit columns.',
    body: () => (
      <>
        <p>
          Files express the direction of money in three common ways. Pick the <strong>amount
            convention</strong> that matches yours so debits and credits land with the right sign:
        </p>
        <ul>
          <li><strong>Single column: negative = debit.</strong> One signed amount column where outflows are
            negative.</li>
          <li><strong>An amount column + a debit/credit type column.</strong> One unsigned amount column plus a
            column that says debit/credit (or deposit/withdrawal).</li>
          <li><strong>Two columns: separate debit / credit.</strong> Debits in one column, credits in
            the other.</li>
        </ul>
        <p>
          {APP_NAME} tries to infer the convention.
        </p>
        <p>
          <strong>Amounts are all in one currency, set on the Settings page.</strong> An amount is stored
          as a plain number with no currency recorded beside it. The setting indicates the currency
          for all of the amounts in the ledger. Changing it relabels existing amounts rather than
          restating them. Outside of choosing the currency symbol, the setting has one other
          effect: when a connected data source reports that an account is held in a
          <em>different</em> currency, its transactions are <strong>not imported</strong>. The account mapping screen and syncs indicate this rather than
          leaving the account mysteriously empty. Skipping such an account keeps it out of the way.
          If a data source contains multiple currencies, transactions in a foreign currency
          will be dropped.
        </p>
      </>
    ),
  },
  {
    id: 'amazon-import',
    section: 'importing',
    title: 'Importing Amazon order detail (AZAD Chrome extension)',
    surfaces: ['Import / Export — Amazon'],
    summary: 'Capture Amazon order detail using a Chrome browser extension to export order history. Per-item detail can be captured as well, which is what allows an order to be split across categories. The corresponding Amazon charges are re-categorized as money movement to avoid double counting the charges.',
    body: () => (
      <>
        <p>
          Amazon purchases appear in the funding account as some form of <strong>AMAZON.COM</strong> and the amount with no detail
          about the purchase. Amazon order history can be exported to a CSV file using the
          open-source <strong>AZAD</strong> (Amazon Order History Reporter) Chrome browser
          extension. {APP_NAME} reads the <strong>Orders</strong>{' '}
          file to create transactions in an Amazon account, links
          it to the matching Amazon charge in the transaction ledger, and excludes the payment from
          totals so it is not counted twice.
          The <strong>AZAD</strong> tool can also generate a CSV containing item detail about the orders.
          If this file is imported the item detail is available to split an order up into its individual items.
        </p>
        <p><strong>Installation:</strong></p>
        <ul>
          <li>
            From a Chrome browser, open this page {' '}
            <a href="https://chromewebstore.google.com/detail/amazon-order-history-repo/mgkilgclilajckgnedgjgnfdokkgnibi" target="_blank" rel="noreferrer">Chrome Web Store</a>{' '}
            and install the extension (details are on the{' '}
            <a href="https://github.com/philipmulcahy/azad" target="_blank" rel="noreferrer">AZAD project page</a>).
          </li><li>
            The default install is all that is needed &mdash; <em>preview / premium features</em> are not required.
          </li><li>
            After the extension is installed, browse to Amazon.com and log in, it will be running on the
            top of the page. Eventually it will finish and close.
          </li>
        </ul>
        <p><strong>Exporting data: The Orders and Items files:</strong></p>
        <ol>
          <li>
            Sign in to Amazon, load the orders page and then open the AZAD extension.
            Check <strong>Show totals in csv downloads</strong>. The other fields are optional.
          </li>
          <li>Select the <strong>Orders</strong> option and select a year or one of the monthly
            time periods.</li>
          <li>
            A tab may open with a Page Not Found error, something like <i>SORRY we couldn't find that page, Try searching or go to
              Amazon's home page</i>. Just close this tab. The results are on the prior tab where the order page had been opened.
          </li>
          <li>
            When the table finishes loading, change <strong>Show 10 entries</strong> to <strong>All</strong>,
            and select <strong>download spreadsheet ('.csv')</strong>.
          </li>
          <li>
            <em>Optional:</em> Select the <strong>Items</strong> report and run the export again for the same time period.
            Select all rows (not 10) and save it under a different name.
            <p>
              The Items file adds the list price and quantity of each item. This detail is then
              available when splitting the order across categories, so the individual items can be
              categorized rather than the whole order carrying a single category. When item detail is
              present the <HelpLink to="/help/transaction-splits">split editor</HelpLink> opens with
              one line per item and the amounts filled in from the items file.
            </p>
          </li>
          <li>Repeat for each year you want to bring in.</li>
        </ol>
        <p><strong>Loading the Orders and Items files:</strong></p>
        <p>
          Load the files using either the CSV importer on the <strong>Import</strong> tab
          or on the <strong>Amazon</strong> tab.
          The files are recognized by their contents and so
          upload order does not matter. The importer has a
          <strong> mapping screen</strong> (like the CSV importer): pick the <strong>account</strong> that tracks
          the Amazon transactions,
          confirm the <strong>category</strong> used for categorizing the matched card charges (e.g. to exclude them
          from spending totals), and map the <strong>payment card(s)</strong> from the Amazon data to payment
          account(s). Items and Orders files can be loaded in the same operation or in either order.
        </p>
        <p>
          After the initial load,
          periodically re-export the current year, or the recent few months, to pull in recent purchases.
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
    title: 'Amazon import page',
    surfaces: ['Import / Export — Amazon'],
    summary: `Configures which account holds the Amazon transactions, which category the excluded Amazon payment maps to, and mapping the payment sources in the CSV file to accounts in ${APP_NAME}.`,
    body: () => (
      <>
        <p>
          This is the page that appears when Amazon CSV files are selected for
          import.
        </p>
        <p>
          <strong>Category for the excluded charge.</strong> When the payment for an Amazon purchase is
          matched, it is re-categorized using this category. This category should be excluded from totals &mdash;
          {APP_NAME} warns if it is not &mdash; so that
          the spending is not double counted. Changing this category
          applies to <em>future</em> imports only, already-imported charges keep their category.
        </p>
        <p>
          <strong>Import into account.</strong> The imported Amazon transactions are tracked in this account which
          is how they are identified as Amazon purchases. The suggested name is <strong>Amazon</strong>. There can be
          more than one if there are multiple Amazon accounts to separate out purchases for some purpose.
        </p>
        <p>
          <strong> Payment cards in these files</strong> lists all the payment cards
          found in the import set along with the current mapping if these cards have been seen before.
          Any new cards are listed with <strong>Needs mapping</strong>. The mapping is used by {APP_NAME} to
          locate the matching <strong>AMAZON.COM</strong> charge so it can change the category to the
          specified <strong>Category for the excluded charge.</strong>
        </p>
        <p>
          Each card can be:
        </p>
        <ul>
          <li><strong>Mapped to an account</strong> &mdash; the normal case; the charge is matched and excluded.</li>
          <li>
            <strong>Untracked</strong> &mdash; a card that isn't one of your accounts (a spouse's card, a
            one-off). Its orders are still recorded and counted; there is no corresponding charge to exclude.
          </li>
        </ul>

      </>
    ),
  },
  {
    id: 'amazon-reconciliation',
    section: 'importing',
    title: 'Amazon reconciliation report',
    surfaces: ['Import / Export — Amazon', 'Import history (transactions ↗ pill)'],
    summary: 'After an Amazon import, a floating report shows how the orders line up with the card charges in the ledger, and includes tools to resolve ambiguous situations.',
    body: () => (
      <>
        <p>
          After importing Amazon orders, {APP_NAME} pairs each order with the card charge that paid for it and
          excludes that charge so the money counts once. The <strong>reconciliation report</strong> shows how
          that went &mdash; open it from <strong>View reconciliation report </strong> after an import, or from
          the file's <strong>transactions ↗</strong> pill in the import history. It floats free of the page
          (drag, resize, or <strong>Minimize</strong> it to the nav bar), so it can be put aside if there
          is a need to inspect transactions and come back to it.
        </p>
        <p>
          Rows group into:
        </p>
        <ul>
          <li><strong>Duplicate detected</strong> &mdash; two or more identical charges made the order ambiguous,
            perhaps the same charge imported twice.
            <p>
              Resolve with:
            </p>
            <ul>
              <li>
                <strong>Merge, keep one</strong> keeps the richest copy (folding in any detail
                the others carried), trashes the rest, and matches the order;
              </li>
              <li>
                <strong> Not duplicates</strong> marks the copies as distinct purchases instead
                (never re-flagged; the order falls back to the unmatched path, and a copy dated on
                the order itself is re-suggested for review). When other unmatched orders share the
                amount, Merge isn't offered &mdash; use Not duplicates, or the per-copy Discard.
              </li>
              <li>
                <strong>Discard</strong> for a copy you know is a double import.
              </li>
            </ul>
          </li>
          <li>
            <strong>Duplicate · review</strong> &mdash; a same-amount charge, but <em>outside</em> the
            strict &plusmn;3-day match window but within two weeks. Likely still a double import, but the dates
            don't corroborate it &mdash; so examine each copy (hover for its origin detail), then resolve with
            the same <strong>Merge / Discard / Not duplicates</strong> &mdash; per row, or use bulk-Edit.
            The merged-away copy is restorable from Settings → Trash.
          </li>
          <li>
            <strong>No charge found</strong> &mdash; counted, but no charge was matched to exclude (an untracked
            card, history that predates your imports, an order whose export named no card and whose charge
            doesn't read as Amazon, or a miss). Sometimes searching for the amount locates the corresponding
            transaction. These orders count toward the import's needs-attention total so a stray one gets a look;
            when there's genuinely nothing to link mark it as reviewed.
            <p>
              Resolve with:
            </p>
            <ul>
              <li>
                <strong>Link charges…</strong> opens a picker over the unaccounted charges with a running
                sum against the order total &mdash; check the charge(s) that paid for it (several, if the
                order was split) and link them. A mismatched sum warns but doesn't block.
              </li>
              <li>
                <strong>Mark reviewed</strong> acknowledges it &mdash; it stays listed here but drops out of the attention count so it won't
                keep nagging (Undo puts it back). Works per row or on a bulk selection.
              </li>
            </ul>
          </li>
          <li>
            <strong>Matched · review</strong> &mdash; no single charge equals the order total, but a unique set
            of unaccounted charges sums to it: Amazon billed the order per shipment. A <em>single</em>-charge
            suggestion carries a note naming why it didn't match automatically &mdash; outside the
            ±3-day window, a cent off the total, or imported after the order was.
            <p>
              Resolve with:
            </p>
            <ul>
              <li>
                <strong>Accept</strong> links the whole set.
              </li>
              <li>
                <strong>Dismiss</strong> if it's not a match (it won't be re-suggested). A set spanning
                more than a week is flagged so it can be eyeballed first.
              </li>
            </ul>
          </li>
          <li>
            <strong>Unaccounted · duplicate</strong> &mdash; unaccounted charges that look like <em>copies of each
              other</em> (same account and amount, days apart) with no order for either &mdash; the double import the
            general dedupe can't catch. Resolve with <strong>Merge / Discard / Not duplicates</strong> &mdash; per row,
            or use Bulk Edit. The merged-away copy is restorable from Settings → Trash.
          </li>
          <li>
            <strong>Unaccounted charge</strong> &mdash; ledger charges that look like Amazon, on the cards Amazon
            uses, in this import's date range, that no order accounts for. Best-effort, but surfaced for a look:
            these count toward the import's needs-attention total so a stray one (say, a duplicate the
            report couldn't pair) gets noticed.
            <p>
              Resolve with:
            </p>
            <ul>
              <li>
                <strong>Trash</strong> sends one to Trash &mdash; the escape
                hatch for that unpaired duplicate. It acts on the whole row and also has the bulk
                operation, <strong>Move to trash</strong>. Discarded rows land in
                Settings → Trash's <em>Transactions</em> section.
              </li>
              <li>
                <strong>Discard</strong> on a stacked duplicate row works per-copy.
                Discarded rows land in Settings → Trash's <em>Duplicate transactions</em>.
                Useful when a charge is just a purchase the export didn't cover (nothing to fix).
              </li>
              <li>
                <strong>Mark reviewed</strong> acknowledges it so it drops out of the attention
                count (Undo restores it). Works per row or on a bulk selection.
              </li>
            </ul>
          </li>
          <li>
            <strong>Matched</strong> &mdash; the order and the charge(s) it excluded. If a pairing is wrong
            (a coincidental same-amount charge, or a suggestion you accepted that turned out not to be this
            order's), <strong>Unlink</strong> detaches the charge &mdash; its original category is
            restored and the order returns to <em>No charge found</em>, where <strong>Link charges…</strong>
            can pair it correctly.</li>
        </ul>
        <p>
          Hover any order or charge for its <strong>origin detail</strong> (source file, captured fields,
          imported category), and use the <strong>↗</strong> beside an order to open the Amazon page for
          that order.
        </p>
        <p>
          For batch cleanup, filter with the pills, tick the row checkboxes (or the select-all header), and the
          bulk bar applies <strong>Merge / Accept / Dismiss / Unlink / Move to trash</strong> to every selected
          row that supports it. Rows of different kinds accept different actions, so each button carries the
          number of your selection it applies to &mdash; a selection can be mixed, and each action reaches
          only its own rows.
          Items needing action also show as an <strong>N to resolve</strong> warning on the file card and a task
          on the Tasks page; both clear as you resolve them. Everything the import itself did reverses if you
          undo it.
        </p>
      </>
    ),
  },
  {
    id: 'amazon-import-detail',
    section: 'importing',
    title: 'Amazon import detail report',
    surfaces: ['Import history — outcome pills (orders / items matched / no match / …)'],
    summary: 'The outcome pills on an Amazon file card open a report of what that import actually did: the orders it created, items matched into orders, items with no matching order yet, duplicates, and payments.',
    body: () => (
      <>
        <p>
          Each Amazon file card carries outcome pills &mdash; <strong>orders</strong>, <strong>items
            matched</strong>, <strong>already enriched</strong>, <strong>no match</strong>,{' '}
          <strong>duplicates</strong>, <strong>payments</strong>. Clicking one opens the{' '}
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
          is skipped with an "already imported" notice (no second file card), and undoing an import frees its
          files to import again.
        </p>
      </>
    ),
  },
  {
    id: 'duplicate-report',
    section: 'duplicates',
    title: 'Reading the duplicate-detection report',
    surfaces: ['Import / Export (file ↗ report)', 'Duplicate-detection report'],
    summary: `When the same activity arrives multiple times, this report identifies the clear cases and groups the rest into categories. Review is an undecided match that needs a decision, and the only category counted as pending work (the file's "to review" count and the Tasks warning). Rejected · review (Matched nearby date, No specific match) are already rejected and advisory: examine it, Import anyway if it shouldn't have been rejected, or Mark reviewed. Hover over a pill for a short explanation.`,
    body: () => (
      <>
        <p>
          {APP_NAME} builds one clean ledger out of several sources over time, and the same activity often
          arrives more than once &mdash; once from a card, again from the bank that pays it off, from an
          aggregator that has seen both, or simply because two CSV exports contain overlapping data which is a
          common situation. The dedupe engine settles the clear, high-confidence cases and surfaces the rest.
        </p>
        <p>There are two major types:</p>
        <ul>
          <li><strong>Review</strong> &mdash; an undecided match that <em>needs a decision</em>, usually a{' '}
            <HelpLink to="/help/cross-account-duplicates">cross-account duplicate</HelpLink>. This is the
            category that counts as <strong>pending work</strong>: it drives the file's
            "to review" count and the "Possible duplicate transactions" item on the
            Tasks page.</li>
          <li><strong>Rejected &middot; review</strong> &mdash; <strong>Matched nearby date</strong> and
            <strong> No specific match</strong>. These were already rejected at import and are
            <em> advisory</em> &mdash; they do <strong>not</strong> count as pending work. Examine them to
            confirm the rejection was right; a row that should <em>not</em> have been rejected can be retained
            with <strong>Import anyway</strong>, and the rest can be left alone or cleared from the pills
            with <strong>Mark reviewed</strong> (in bulk). Often a <strong> No specific match</strong> transaction
            can be matched to a transaction further out (search by the amount) than the pairing window reaches, but sometimes it really is a
            transaction which should be included. See{' '}
            <HelpLink to="/help/covered-range-review">covered-range review</HelpLink>.</li>
        </ul>
        <p>
          Click a pill to filter by a group (the header checkbox then selects all of
          it); <strong>hover on a pill</strong> for a short explanation of what it means.
        </p>
        <p>
          A rejected duplicate's detail can be captured and added to the retained transaction.
          When it unambiguously matches one existing
          transaction, <strong>Enrich</strong> folds the <em>new</em> detail (a memo, a transaction id, a
          richer name) into that transaction's source record &mdash; additive and reversible
          (<strong>Unenrich</strong> removes exactly what was added). The file card's
          <strong> Enrich existing transactions from this source</strong> checkbox does the same for the
          whole file at once &mdash; at any time, since rejected rows keep their full detail &mdash; and a
          data source can opt in permanently on its mapping screen so future imports enrich automatically.
          Once a row has enriched its match, its Kind reads <strong>Matched</strong> (green) rather than
          "Rejected": it was recognized as one you already had and contributed its detail, not
          discarded. The additional information becomes part of the hover text displayed when hovering
          over the merchant name and is available for use in rules and when searching for
          transactions.
        </p>
        <p>
          Removing a duplicate is reversible &mdash; see{' '}
          <HelpLink to="/help/removed-as-duplicates">where a removed duplicate went</HelpLink>.
        </p>
        <p>
          A single file listing the same purchase twice is a different problem
          (<HelpLink to="/help/intra-file-duplicates">a source that double-lists rows</HelpLink>).
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
          more than one source on <em>different accounts</em>. This can be real, two people paid for the
          same thing on the same date, a transit trip perhaps, or it can be a mistake where either one source
          has the account wrong or the two sources have different names for the same account and they haven't been
          paired up in {APP_NAME}.
        </p>
        <p>
          If the two accounts get merged, the pair is no longer called cross-account, and the wording
          decides what becomes of it. The amount already matches &mdash; that is what flagged the pair
          &mdash; so where both sources also describe it identically, the merge confirms the duplicate and
          the row leaves the active ledger as a <strong>duplicate in this account (confirmed)</strong>.
          Detaching the accounts reverses that, and a single row can be restored on its own. Where the two
          descriptions merely resemble each other, or share nothing but the payee, that is not conclusive,
          so the row stays in review as a <strong>possible duplicate in this
            account</strong> (or <strong>same payee, different wording</strong>) and still needs one of
          the three actions below.
        </p>
        <p>
          There are three actions:
        </p>
        <ul>
          <li><strong>Keep both</strong> &mdash; they really are two different transactions. If the accounts weren't merged this also
            asserts <em>these two accounts are distinct</em>, so future imports stop re-flagging the pair.</li>
          <li><strong>Discard new</strong> &mdash; the just-imported row is the duplicate; keep the copy
            already in the ledger.</li>
          <li><strong>Replace existing</strong> &mdash; the just-imported row is the <em>better</em> record
            (e.g. it has the correct account). Keep it and remove the existing one.</li>
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
    id: 'covered-range-review',
    section: 'duplicates',
    title: 'Reviewing covered-range duplicates (nearby date / transfer / no match)',
    surfaces: ['Duplicate-detection report'],
    summary: 'When an earlier import already covered a date range, every transaction in that range is expected to already be present, so each transaction being loaded is paired against the existing data by date and amount (the exact date first, then ±1 day, then outward to a week, then a cross-account transfer twin). Three pairing outcomes are surfaced for review: Matched nearby date (a same-account counterpart turned up only after widening the window, and the row shows how many days apart), Possible transfer match (a same-amount row naming this account sits on another account: a wallet funding leg whose twin is already on the books), and No specific match (nothing paired at all, so the row may be genuinely missing from the earlier import).',
    body: () => (
      <>
        <p>
          An import is allowed to be missing transactions at the edges but it is assumed that after seeing
          a transaction from a given source, the import contains all the transactions from that source up
          to the end of the time period covered by the import (again, allowing for fuzziness at the edges).
          If a subsequent import is found to contain a transaction landing inside this range it is rejected as a presumed
          duplicate and {APP_NAME} tries to find the existing match by date and amount &mdash; the exact date first, then
          &plusmn;1 day, then outward a day at a time to a week, and finally a cross-account transfer twin.
        </p>
        <p>
          Three of the pairing outcomes are surfaced for review:
        </p>

        <ul>
          <li><strong>Matched nearby date</strong> &mdash; a counterpart turned up only after the date
            window widened past the exact day; each row states how far apart the two are. Posting dates drift
            between sources for several reasons &mdash; pending vs. posted timing, weekend or holiday
            settlement, and time-zone differences on foreign charges &mdash; so the same transaction can sit
            several days apart in two sources, and the further apart the pair sits the more it is worth a
            glance before clearing. Once the pair
            looks right, <strong>Mark reviewed</strong> clears it from the
            needs-attention list. If a pair turns out <em>not</em> to be the same transaction, select the rows
            and import both.</li>
          <li><strong>Possible transfer match</strong> &mdash; nothing matched on this account, but a
            same-amount transaction naming this account sits on <em>another</em> one, a few days apart. That
            is the signature of a wallet funding/deposit leg (a PayPal/Venmo "Bank Deposit" row)
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
          flagged.
        </p>
        <p>
          See also: <HelpLink to="/help/duplicate-report">reading the duplicate-detection report</HelpLink>.
        </p>
      </>
    ),
  },
  {
    id: 'intra-file-duplicates',
    section: 'duplicates',
    title: 'A source that contains duplicate transactions',
    surfaces: ['Import / Export (duplicate report)'],
    summary: 'Duplicate detection compares an incoming file against what is already in the ledger, so two copies inside one file both import and neither is flagged. The fix is to clean the export before importing it, or to trash the extra copy after.',
    body: () => (
      <>
        <p>
          Some historical export files (Mint was notorious for this) may contain multiple
          copies of the same purchase, sometimes with different
          dates or even sometimes different payment sources (credit cards). This is not something duplicate detection
          can help with.
        </p>
        <p>
          Duplicate detection compares an <em>incoming file</em> against what is already in the ledger. Two
          copies of one purchase sitting inside the same file have nothing to be compared against, so both
          import and neither is flagged. That is deliberate rather than an oversight: the transaction ledger from
          a given source is assumed to be accurate.
        </p>

        <h4>Spotting it</h4>
        <p>
          Sorting the imported file's rows by amount brings identical figures together, which is the
          quickest way to see whether a file is doing this. It tends to be a property of
          the <em>source</em> rather than of one export -- if one file from a source double-lists, later ones
          usually will too, so it is worth checking the first import from any new source. If this is a current
          data provider, it is worth reporting to them as a bug.
        </p>

        <h4>Two ways to deal with it</h4>
        <ul>
          <li>
            <strong>Clean the file before importing.</strong> The better fix where a source does this
            every time or there are many duplicates in a historical file. Work on a copy, keep a record of
            what was dropped, and be generous about what counts as a duplicate -- rows a day or two apart
            with the same amount and merchant. Small fixed-price repeats (a vending machine, a parking meter) may be
            considered acceptable casualties.
          </li>
          <li>
            <strong>Trash the extra copy after importing.</strong> Fine for a one-off. Find the pair on
            the Transactions page, select the copy to remove, and move it to trash -- it stays recoverable
            from Settings until the trash is emptied.
          </li>
        </ul>
        <p>
          Undoing the whole import and starting again from a cleaned file is always available, and is
          usually less work than picking through a long history by hand. A cleaned file can be imported, checked,
          and then removed if it needs further refinement.
        </p>
      </>
    ),
  },
  {
    id: 'removed-as-duplicates',
    section: 'duplicates',
    title: 'Where a removed duplicate went',
    surfaces: ['File ledger (↗)'],
    summary: 'Rows which are replaced or merged as part of duplicate transaction resolution are visible in the "Removed as duplicates" section at the top of each import file card\'s transaction report.',
    body: () => (
      <>
        <p>
          When a <HelpLink to="/help/cross-account-duplicates">Replace</HelpLink> or a{' '}
          <HelpLink to="/help/merging-accounts">merge</HelpLink> removes a duplicate, the row is added
          to the removed duplicates report for the import. Open a file's ledger (the <strong>↗</strong>) and expand the collapsible
          <strong> Removed as duplicates</strong> list: it shows each removed row and which account the retained
          copy now lives on. Duplicate charge copies merged away on the <em>Amazon reconciliation
            report</em> land here too &mdash; for those the kept copy is usually on the <em>same</em> account (a
          doubled import of one charge), and the removed copy is restorable from Settings → Trash.
        </p>
      </>
    ),
  },
  {
    id: 'page-tasks',
    section: 'tasks',
    title: 'Tasks',
    surfaces: ['Tasks'],
    summary: 'A short list of things worth a look: transactions with no category, duplicates awaiting a decision, reimbursements outstanding too long, recurring charges that did not arrive. Nothing here is an error, and nothing has to be done in order.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          Tasks collects what the rest of the app noticed and did not want to interrupt for. The count
          beside <strong>Tasks</strong> in the navigation is how many are open. Each entry says what
          was found and links to the page where it is dealt with.
        </p>
        <p>
          What appears is deliberately narrow. An item tied to a feature stays hidden until that
          feature is in use, so an installation that does not track owners is never asked to assign
          one, and a new installation is not met with warnings about things that were never set up.
        </p>
        <p>
          A task that is not worth acting on can be <strong>dismissed</strong>, which hides it until
          there is more of it rather than for good. What is remembered is the count it was dismissed
          at, and that mark falls again as the list shrinks, so clearing part of a backlog does not
          bury the next new item underneath the old number.
        </p>
        <p>
          Recurring findings work differently.
          A <HelpLink to="/help/recurring-transactions">missing or changed charge</HelpLink> is an
          individual finding, dismissed one at a time on the Recurring page rather than as a group
          here.
        </p>
      </>
    ),
  },
  {
    id: 'page-settings',
    section: 'settings',
    title: 'Settings',
    surfaces: ['Settings'],
    summary: 'Appearance and currency, the tag manager, sign-in protection, the trash, and the configuration screen. Almost none of it has to be touched to use the app.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>Settings is one page of collapsible sections. The ones worth knowing about:</p>
        <ul>
          <li>
            <strong>Appearance</strong> and <strong>Currency</strong> set the theme, and the currency
            symbol every amount is shown with.
          </li>
          <li>
            <strong>Transaction tags</strong> is the tag manager, where tags are renamed and removed.
            See <HelpLink to="/help/tags">how tags work</HelpLink>.
          </li>
          <li>
            <strong>Sign-in protection</strong> and <strong>User management</strong> control who can
            reach the app over the network.
            See <HelpLink to="/help/account-security">account security</HelpLink>.
          </li>
          <li>
            <strong>Intended usage</strong> covers where the data lives and what protects it.
            See <HelpLink to="/help/data-and-backups">data on disk, and backups</HelpLink>.
          </li>
          <li>
            <strong>Trash</strong> holds deleted transactions and rules until it is emptied, in
            sections that empty separately.
          </li>
          <li>
            <strong>Configuration</strong> shows where each setting's value comes from and what an
            override would change.
            See <HelpLink to="/help/configuration">configuration settings</HelpLink>.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'data-and-backups',
    section: 'access-safety',
    title: 'Data on disk, and backups',
    surfaces: ['Intended usage (Settings)'],
    summary: `Transactions live in a plain-text database on a presumably private system. Handle the file carefully if the data is considered sensitive.`,
    body: () => (
      <>
        <p>
          Almost everything is stored in a local SQLite database (attachments are stored in a documents directory next
          to the database file). Accounts, transactions, categories, tags are all stored in{' '}
          <strong>plain text</strong>. Protection comes from the computer's security (disk encryption,
          OS login, who can physically reach the machine, who has access to the network), not from {APP_NAME}.
          A sign-in password is available to restrict <em>network</em> access to the app.
        </p>
        <p>
          If the contents of the database are considered sensitive, {APP_NAME} can generate key pairs to build
          strongly encrypted backup files. Secrets and credentials for accessing connected data sources
          are already encrypted in the control database, secured by the vault passphrase. All backups
          of the credentials database contain encrypted data.
        </p>
        <p>
          If the database files are exposed and there are data connections, even though the credentials
          are protected by a strong passphrase, the mitigation step is to revoke the existing credentials
          and issue new ones. Some providers support revoking the credentials via their API in which case
          disconnecting the account(s) from within {APP_NAME} revokes the lost credentials. For other providers
          it is necessary to remove the existing credential on the provider side and issue a new one. Even with
          providers which support revocation via the API, there is a secret worth rotating on the
          provider side which was used to authorize the connections in the first place.
        </p>
        <p>
          Once the provider stops accepting the stored credential, the connection card
          reports <strong>reconnect needed</strong> rather than counting failed syncs.
        </p>
      </>
    ),
  },
  {
    id: 'account-security',
    section: 'access-safety',
    title: 'Account security: password and two-factor',
    surfaces: ['Account security (Settings)'],
    summary: `Sign-in protection is a network perimeter: it keeps people who aren't users out. It is not disk encryption, and everyone signed in shares the same data. Two-factor adds a code at sign-in and is optional.`,
    body: () => (
      <>
        <p>
          Sign-in protection exists to keep <strong>non-users out</strong> and to control access to
          certain administrator functions (users can be designated an administrator or not).
          Everyone who signs in sees and edits
          the <strong>same shared data</strong>; the password guards <em>network</em> access only: it
          is not disk encryption, so
          it is not a substitute for keeping the machine itself secure (see{' '}
          <HelpLink to="/help/data-and-backups">data on disk, and backups</HelpLink>).
        </p>
        <p>
          <strong>Password policy</strong> sets how strong account passwords must be. It applies to
          all users, and it can be tightened or relaxed at any time.
        </p>
        <p>
          <strong>Two-factor (an authenticator app)</strong> adds a one-time code after the password.
          When it is on, the code is requested <strong>every fresh sign-in</strong> &mdash; a browser
          with an active session is not asked again until that session ends, but there is no "trust
          this device" that skips the code on a new sign-in. If authenticator access is lost, the{' '}
          <strong>recovery codes</strong> displayed when authenticator use is enabled
          are the way back in, so save these in a password manager or somewhere equally safe.
        </p>
        <p>
          Two-factor is optional and mainly matters if the instance is reachable beyond the trusted
          network. On a trusted home network it adds little and leaving it turned off is
          reasonable.
        </p>
      </>
    ),
  },
  {
    id: 'configuration',
    section: 'access-safety',
    title: 'Configuration settings',
    surfaces: ['Configuration (Settings)'],
    summary: `Every setting has a working default; configuration is not required to get started. A .env file overrides the handful of values that need to be known before the app starts (ports, where the database files live).`,
    body: () => (
      <>
        <p>
          Nothing has to be configured before {APP_NAME} runs. Every setting falls back to a working
          default, so a plain installation needs <strong>no configuration file at all</strong>.
        </p>
        <p>
          Three settings worth knowing about:
        </p>
        <ul>
          <li>
            <strong>Data directory</strong> is where both database
            files live &mdash; change to move an installation's data, possibly to run a
            second installation on the same machine. The two database rows beneath it are shown for
            confirmation and follow it automatically.
          </li>
          <li>
            <strong>Backend port</strong> needs to be an unused port and is used by the frontend
            to connect to the backend. Users do not need to be aware of this port.
          </li>
          <li>
            <strong>Frontend port</strong> is the port the browser connects to.
          </li>
        </ul>
        <p>
          Most users do not need to touch the settings under <strong>Advanced</strong>.
        </p>
        <p>
          Each setting indicates how the current value is derived:
        </p>
        <ul>
          <li>
            <strong>Default</strong> is the built-in value.
          </li>
          <li>
            <strong>Stored</strong> means it was generated once and kept in the database.
          </li>
          <li>
            <strong>Derived</strong> means it follows another setting.
          </li>
          <li>
            <strong>Set in .env</strong> or <strong>Set in environment</strong> means an override is in
            force &mdash; an override always wins, and always takes effect at the next restart.
          </li>
        </ul>
        <p>
          The <code>.env</code> file lives beside the
          application. If it is present the screen indicates where it lives.
        </p>
        <p>
          Stored values can be cleared but not typed. <strong>Reset</strong> forgets a stored value so the
          current default applies again, and <strong>Regenerate</strong> replaces the session signing key
          &mdash; worth doing if it may have been exposed, such as in a shared backup. Both take effect at
          the next restart, and both end every active session, so everyone signs in again. Neither is
          offered while an override is in force, because the override would still win.
        </p>
      </>
    ),
  },
]

export const HELP_TOPICS_BY_ID = Object.fromEntries(HELP_TOPICS.map(t => [t.id, t]))
