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
 *
 * Whitespace here is JSX's, not HTML's: a text run that *starts* on a new line has
 * its leading newline stripped, so `</strong>` (or `)`) followed by a line break
 * and then a word renders with no space between them. Breaking a line right after
 * an element therefore needs an explicit `{' '}`. Interior newlines inside one run
 * of text are fine -- they collapse to a single space. The failure is invisible in
 * the source and only shows in the rendered body, so check the output rather than
 * the JSX when a paragraph is reflowed.
 *
 * Emphasis: `<strong>` is for anything the reader can find on the screen by that name -- a button, tab,
 * pill, field label or heading -- and for the term a passage or list item is defining. `<em>` is for
 * stress on a word, example values, and the names of data rather than controls: categories, groups and
 * tags, the built-in ones included (<em>Money movement</em>, <em>Skip</em>).
 *
 * `<div className="help-box">` draws a box round a heading and what follows it, for a part of a topic
 * that should read as separate from the field-by-field text around it.
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
 * How the sections are chosen: most mirror a page in the left nav and lead with that page's `page-*` hub
 * topic -- the one its title's `?` opens, which also collects the page's related
 * topics as links. The rest are subjects that outgrew a single page and stand on their own
 * ("Duplicates & reconciliation", "General concepts"), because a topic does **not** have to sit
 * under the hub of the page it is reached from: a topic carries one `section` but several
 * `surfaces`, so it is filed by *subject* and the other pages' hubs link across to it. Ordering
 * within a section is deliberate rather than the order topics were written -- hub first, then the
 * core model, then common tasks, then edge cases -- because array position is the only thing
 * driving it.
 *
 * Sections come in three `group`s, in this order and each alphabetical by label so a section is quick
 * to find: `start` (Getting started), `page` (one per nav page) and `subject` (the rest). The topic
 * index starts each group on its own line.
 */
export const HELP_SECTIONS = [
  {
    key: 'getting-started',
    group: 'start',
    label: 'Getting started',
    blurb: `What ${APP_NAME} is for, and loading the first data.`,
  },
  {
    key: 'accounts',
    group: 'page',
    label: 'Accounts',
    blurb: 'Where transactions come from, connecting data providers, and pairing up accounts that turn out to be the same one.',
  },
  {
    key: 'categories',
    group: 'page',
    label: 'Categories & tags',
    blurb: 'Two ways to organize transactions for reports: a category tree and cross-cutting tags.',
  },
  {
    key: 'dashboard',
    group: 'page',
    label: 'Dashboard',
    blurb: 'Reading the reports: what each breakdown counts, and the alternate frames.',
  },
  {
    key: 'importing',
    group: 'page',
    label: 'Importing data',
    blurb: 'Mapping files, saving reusable sources, and bringing in marketplace order detail.',
  },
  {
    key: 'recurring',
    group: 'page',
    label: 'Recurring transactions',
    blurb: 'Transactions that repeat on a schedule: what the scan finds on its own, and how to declare one it cannot see.',
  },
  {
    key: 'rules',
    group: 'page',
    label: 'Rules',
    blurb: 'How categorization is kept up automatically, and what happens when two rules want the same transaction.',
  },
  {
    key: 'settings',
    group: 'page',
    label: 'Settings',
    blurb: 'The one page of preferences, and what each section of it covers.',
  },
  {
    key: 'tasks',
    group: 'page',
    label: 'Tasks',
    blurb: 'The nag list: what gets raised there, and what dismissing one means.',
  },
  {
    key: 'transactions',
    group: 'page',
    label: 'Transactions',
    blurb: 'Working the ledger: finding a transaction, reviewing new ones, and recording what a row does not say on its own.',
  },
  {
    key: 'duplicates',
    group: 'subject',
    label: 'Duplicates & reconciliation',
    blurb: 'When the same activity arrives from more than one source: what the engine settles on its own, and how to resolve what it cannot.',
  },
  {
    key: 'general-concepts',
    group: 'subject',
    label: 'General concepts',
    blurb: `What holds for the whole ledger rather than one page: the single currency, how the data is backed up, and who can reach it.`,
  },
  {
    key: 'administration',
    group: 'subject',
    label: 'Server Configuration',
    blurb: 'Running the installation: how it starts, who can reach it, and keeping its databases in order.',
  },
]

export const HELP_TOPICS = [
  {
    id: 'how-luma-works',
    section: 'getting-started',
    title: `How ${APP_NAME} works`,
    surfaces: ['Getting started', 'Dashboard'],
    summary: `${APP_NAME} is for digging into spending patterns. Accounts, owners, categories, tags, rules are tools to help answer questions about the spending.`,
    body: () => (
      <>
        <p>**needs review** - just a read though, keeping up to date @ end removed</p>
        <p>
          Two features sit at the center of {APP_NAME}: <strong>reports</strong> (mostly through the
          dashboard) and <strong>searching</strong> the transaction history. Accounts, owners, categories,
          tags, and rules all exist to make those two better, and they can be used or not depending on
          whether they are helpful.
        </p>
        <p>
          A few things hold for the whole ledger rather than for any one page:
        </p>
        <ul>
          <li>
            All of the data remains local unless it is moved somewhere else; {APP_NAME} never makes an
            outgoing connection unless specifically requested (e.g. downloading transactions from a data
            provider, storing a backup on a cloud service). Where the data sits and how to keep a copy of
            it are covered in <HelpLink to="/help/backup-restore">Backup / Restore</HelpLink>.
          </li>
          <li>
            Amounts are all in one currency, chosen once for the whole ledger &mdash;
            see <HelpLink to="/help/single-currency">single-currency support</HelpLink>.
          </li>
          <li>
            Reaching the app over a network can be gated by a password, with an optional code at
            sign-in. See <HelpLink to="/help/account-security">account security</HelpLink>.
          </li>
          <li>
            Every setting has a working default; the handful that have to be known before the app starts
            (ports, where the database files live) come from a file beside it. See{' '}
            <HelpLink to="/help/configuration">configuration settings</HelpLink>.
          </li>
        </ul>
        <p>
          To get started:
        </p>
        <ol>
          <li>
            Load transactions - Import files on the Import page, connect
            a <HelpLink to="/help/data-providers">data provider</HelpLink>, or both;{' '}
            <HelpLink to="/help/import-strategy">choosing how to bring data in</HelpLink> covers
            which suits what. If there are several files to be imported, import them all before moving
            on. Loading transactions creates the accounts which they are mapped to, and accounts which
            arrive under different names from different sources can be mapped to match during the
            import or later on the Accounts page.
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
                on the Import page can bring them in to the system and propose matching rules based on
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
    summary: 'A description of the major sections and how they fit together.',
    body: () => (
      <><p>The major sections roughly in the order data moves through them:</p>
        {/* A table rather than the prose tour this used to be: ten sections described at paragraph length
            restated their own topics, and what a reader wants here is which part owns which job. Each row
            earns its place by saying what the part is *for*, which a title cannot. */}
        <div className="help-table-scroll">
          <table>
            <thead>
              <tr><th>Part</th><th>What it is for</th></tr>
            </thead>
            <tbody>
              <tr>
                <td><HelpLink to="/help/page-import-export">Import</HelpLink></td>
                <td>Load transactions. Strong duplicate detection
                  so overlapping files and sources are safe to import.</td>
              </tr>
              <tr>
                <td><HelpLink to="/help/page-accounts">Accounts &amp; owners</HelpLink></td>
                <td>Transactions belong to an account and accounts belong to an owner. Useful
                  for filtering and reporting.
                </td>
              </tr>
              <tr>
                <td><HelpLink to="/help/page-transactions">Transactions</HelpLink></td>
                <td>The ledger as a list.</td>
              </tr>
              <tr>
                <td><HelpLink to="/help/page-categories">Categories &amp; groups</HelpLink></td>
                <td>Some groups carry behavior to keep money movement out of the totals. Otherwise
                  groups and categories support reporting and identifying recurring patterns.</td>
              </tr>
              <tr>
                <td><HelpLink to="/help/tags">Tags</HelpLink></td>
                <td>User defined labels to identify transaction groups which cross the other categories
                  or are otherwise interesting to identify.</td>
              </tr>
              <tr>
                <td><HelpLink to="/help/page-rules">Rules</HelpLink></td>
                <td>Handle the task of categorizing transactions as they are loaded.
                </td>
              </tr>
              <tr>
                <td><HelpLink to="/help/recurring-transactions">Recurring transactions</HelpLink></td>
                <td>Detected patterns of charges repeating on a schedule. Alerts about missed payments
                  and changes in the payment amount.
                </td>
              </tr>
              <tr>
                <td><HelpLink to="/help/page-dashboard">Dashboard</HelpLink></td>
                <td>Visual representation of the transactions.</td>
              </tr>
              <tr>
                <td><HelpLink to="/help/page-tasks">Tasks</HelpLink></td>
                <td>Alerts which may be of interest. Dismiss them if they are not.</td>
              </tr>
              <tr>
                <td><HelpLink to="/help/page-settings">Settings</HelpLink></td>
                <td>Preferences, Backup / Restore, the Trash, and for administrators the server: users,
                  sign-in protection and startup configuration.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </>
    ),
  },
  {
    id: 'import-strategy',
    section: 'getting-started',
    title: 'Loading transactions',
    surfaces: ['Getting started'],
    summary: 'Transactions can be loaded from files, via a data connection, or from both, depending on what is available for the various sources. Amazon, PayPal and P2P payer exports can be added to capture purchase detail for otherwise opaque transactions.',
    body: () => (
      <>
        <p>
          Transactions come from files, from a data connection, or from both. Some sources of information
          such as Amazon transaction detail is only available as a file, others can be pulled from a data provider.
          The issues affecting which route is picked tend to be convenience, cost, and privacy.
        </p>
        <ul>
          <li>
            <strong>Downloading from each bank.</strong> Most banks and card issuers offer a CSV
            export. It costs nothing and no one else sees the data, but staying current means a fresh
            file from each one: trivial for two accounts, a chore for a dozen. CSV files are often used
            for moving between tools of this nature as a way to preserve the already curated transaction data.
            For this situation Luma can be asked to build rules from the incoming data to preserve
            that work.
          </li>
          <li>
            <strong>An aggregated view&apos;s export.</strong> Some budgeting apps, brokerage accounts
            and a growing number of banks can link outside accounts held elsewhere and show them in one place, often
            at no charge. When they support exporting everything as a CSV, this can be a convenient way to keep all
            the accounts up to date from a single CSV export/import.
            Like with all aggregation services, this means that the institution and possibly the
            connection service can see every transaction from the linked accounts.
          </li>
          <li>
            <strong>A <HelpLink to="/help/data-providers">data provider</HelpLink>.</strong> If available
            this provides a connection where {APP_NAME} can download account data directly. A sync button
            brings in new transactions without requiring exports/imports. The data provider and whatever
            connection technology they use (some providers are reselling other services) can see the
            transaction and account data.
          </li>
        </ul>
        <p>
          All of this is very flexible and it is fine to mix and match. If data is brought in both from a
          data provider and via CSV files and there are accounts that are covered by both, it is
          better to skip the already covered account in the CSV file's data source mapping as this
          keeps the duplicate transaction report cleaner. If an account is brought in from multiple
          sources it is likely there are duplicate transactions which will not be able to be
          resolved automatically and will be posted for review. This does not cause trouble, it is
          simply extra work.
        </p>
        <p>
          Which accounts are worth bringing in at all is covered
          on <HelpLink to="/help/page-accounts">the Accounts page</HelpLink>.
        </p>
        <h4>Sources worth having</h4>
        <ul>
          <li>
            If cash flow is all that is interesting, simply adding data from the bank accounts is probably
            sufficient. Bringing in data from credit card accounts adds transaction detail to the
            charge which shows up as the monthly credit card payment in the bank account. When the
            credit card is added the payments are excluded from spending totals so the spending is not
            double counted.
          </li>
          <li>
            Amazon purchase detail can be added by exporting the Amazon purchase history
            using a Chrome browser extension. This provides detail to the charges which
            show up as some form of <em>AMAZON.COM</em>. Charges which cover multiple
            purchases on the Amazon end can be split in the ledger to attribute the spending
            to multiple categories. <HelpLink to="/help/amazon-import">Amazon order export</HelpLink> contains
            details on exporting the Amazon order history.
          </li>
          <li>
            PayPal CSV exports and <HelpLink to="/help/paypal-statements">PDF statements</HelpLink> can
            be imported to add purchase detail
            to the PayPal income/spending recorded on credit card and bank
            statements.
          </li>
        </ul>
        <p>
          Details for adding purchase detail from Amazon and PayPal accounts
          is described in <HelpLink to="/help/purchase-detail">adding purchase detail from Amazon and
            PayPal</HelpLink>.
        </p>
        <h4>Arriving with categorized data</h4>
        <p>
          Data brought in from another tool is often already categorized. <HelpLink to="/help/imported-category-cleanup">Group imported categories</HelpLink> indicates
          that {APP_NAME} should import
          categories from the incoming data and <HelpLink to="/help/generate-rules">Generate rules</HelpLink> indicates
          that {APP_NAME} should generate rules based on the
          categorization patterns in the incoming data.
        </p>
      </>
    ),
  },
  {
    id: 'page-dashboard',
    section: 'dashboard',
    title: 'The Dashboard',
    surfaces: ['Dashboard'],
    summary: 'A visual way to explore the ledger.',
    body: () => (
      <>
        <p>
          The dashboard is a visual representation of the transaction data. There are various reporting views
          to investigate where money is going and surface spending patterns. The dashboard can also be useful for
          validating that transactions are correctly categorized and for digging into details behind anomalous patterns.
        </p>
        <ul>
          <li>
            <strong>Report types:</strong> <strong>Expense, Income, Cash Flow, Net worth:</strong> Expense and Income are pie
            charts, <HelpLink to="/help/dashboard-cash-flow">Cash Flow</HelpLink> is a
            Sankey diagram, <HelpLink to="/help/dashboard-net-worth">Net worth</HelpLink> totals the account balances.
          </li>
          <li>
            <strong>Report sub-types:</strong> <strong>Single, Compare, Trends</strong> toggle between examining
            a period of time, comparing two periods and examining trends over time.
          </li>
          <li>
            The single period report has a selector to break the results down by group, by category or
            by a set of tags (<HelpLink to="/help/dashboard-tag-reports">tag report</HelpLink>). Tags are
            only available on the expense and income reports, not on the cash flow report.
          </li>
          <li>
            The <strong>Date</strong> and <strong>filter</strong> controls at the top of the page affect which transactions are included
            for all of the reports. A combination used often can be kept as
            a <HelpLink to="/help/saved-filters">saved filter</HelpLink>.
          </li>
        </ul>
        <p>
          Everything can be drilled into to reach the underlying transactions. Clicking a group opens its categories, clicking a category opens
          the transactions behind it, and anything filed wrongly can be corrected from there. On the single
          period report the trend follows the drill, showing the open group or category over time; clicking
          one of its bars moves the period and keeps the drill. Using
          the dashboard to check the data is as much its purpose as reporting on it.
        </p>
        <p>
          The period, amount and filter at the top of the page remain in effect when switching between the Dashboard
          and Transaction pages so that switching between the views displays the same set of transactions.
          The <strong>💲 Amount</strong> filter limits the reports to money paid out (debits), money received
          (credits) or a range of amounts.
        </p>
        <p>
          Categories{' '}
          <HelpLink to="/help/exclude-from-totals">excluded from totals</HelpLink> are not included
          in any of the dashboard reports unless the group or category is added to the filter.
        </p>
      </>
    ),
  },
  {
    id: 'dashboard-net-worth',
    section: 'dashboard',
    title: 'Net worth',
    surfaces: ['Dashboard frame selector'],
    summary: 'The total of the account balances, by account type: what moved it over a period on Single period, each month end on Trends.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          Net worth adds up the balances of every account except those marked to be left out of it on the
          Accounts page. Accounts of type Other are always left out. Accounts are grouped and coloured by
          type; clicking a type opens its accounts, and clicking an account opens its report.
        </p>
        <ul>
          <li>
            <strong>Single period:</strong> the figure at the end of the period and what moved it, from net
            worth at the start, a step for each type, to net worth at the end, the two ends drawn as what each
            type makes of them. An account whose history begins
            during the period counts as starting it at zero. Below, net worth at
            the end of each month, quarter or year, as far back as the Expenses trend reaches; clicking a bar
            makes it the period.
          </li>
          <li>
            <strong>Trends:</strong> each month end, with what is held above zero, what is owed below, and
            net worth as the line.
          </li>
        </ul>
        <p>
          Only the owner filter applies. The other filters choose transactions, and a balance belongs to an
          account.
        </p>
        <p>
          A balance on an earlier date starts from the nearest balance stated on or before that date, by a
          connection or entered by hand, and adds the transactions since. Before the first one it is worked
          back through the transactions. An account counts only from its first balance or transaction; an
          account with no balance at all is not counted.
        </p>
        <p>
          A ⚠ marks a balance not updated recently, or a history the transactions cannot explain: working
          back lands an account well on the wrong side of zero, which usually means transactions are missing,
          often where an account moved from imported files to a connection. Entering a balance from a
          statement fixes it; the warning offers the date it would fix the most, the day of that move when it
          can find it. Otherwise net worth can count the account only from a later date, offered as the
          furthest back its transactions hold up, or the warning can be dismissed, which changes nothing. The date is shown, and can be changed, on the
          account&apos;s page.
        </p>
      </>
    ),
  },
  {
    id: 'dashboard-cash-flow',
    section: 'dashboard',
    title: 'Cash flow',
    surfaces: ['Dashboard frame selector'],
    summary: 'Another way to view spending showing what came in against what went out. Single period uses a Sankey diagram; Trends displays money in and money out as bar graphs by year and by month.',
    body: () => (
      <>
        <p>
          <strong>Cash flow</strong> combines spending and income into one graph. It is
          based on transaction dates as opposed to actual money movement. This means that a
          credit card transaction is treated as being paid for on the date of the purchase rather than the
          date on which the credit card payment was made so the time frame of when the money actually left
          is not 100% accurate.
        </p>
        <p>
          The Sankey diagram for the <strong>single period</strong> report depicts income on the
          left, the net in the middle, and expenses on the right. The width of each band represents the
          amount. Clicking a band drills down a level: a group opens its categories, a category opens its
          transactions. When the buckets become too thin to read, the remainder
          collapses into a single <em>Other</em> band that expands when clicked.
        </p>
        <p>
          The difference between spending and income is added as either <strong>Net saved</strong> if
          positive and <strong>Net drawdown</strong> if negative (expenses exceed income).
        </p>
        <p>
          <strong>Trends</strong> on the Cash Flow report is displayed as bars around a zero
          line &mdash; income as a positive bar, expenses as a negative bar with the net spending as
          a line across the chart. Clicking a month on the bottom chart opens its transactions;
          double-clicking switches to the single-period view for that month.
        </p>
        <p>
          Groups and Categories under Expenses can
          contain income transactions for reimbursable expenses, purchases returned, etc. The income may
          fall into a different period than the purchase leading a normally negative spending category
          to be positive (income) for a particular period. On the Dashboard reports, groups and categories
          are treated as income or expense not by the structure on the categories page but by whether the
          spending for the period exceeds the income or not.
        </p>
        <p>
          Transactions which are excluded from totals because the category
          assignment indicates they are money movement or reimbursement related
          (see <HelpLink to="/help/exclude-from-totals">groups excluded from totals</HelpLink>) are
          not included in the cash flow reports the same as they
          are not included in the other dashboard reports.
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
          to include and either press <strong>Save &amp; display</strong> to save the report
          or <strong>Display</strong> to see the report without saving.
          Right-click (or use the &middot;&middot;&middot; menu) to rename a saved report, change its
          tags, or delete it. The same menu on an unsaved report changes its tags or saves it under a name.
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
    id: 'saved-filters',
    section: 'dashboard',
    title: 'Saved filters',
    surfaces: ['Filter bar'],
    summary: 'A named set of filters (period, amount and filter chips) that is applied with one click from the filter bar.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          With any filter set, <strong>Save&hellip;</strong> beside <strong>Clear all</strong> names the current
          period, amount and filter chips. The saved filter appears as a chip beside the funnel button
          at the start of the filter bar. Clicking it replaces the filters in force, and the chip stays highlighted
          while the filters match it. The filters it sets can be adjusted like any others without changing
          the saved copy.
        </p>
        <p>
          Right-click a saved filter (or use its &middot;&middot;&middot; menu) to rename it, delete it, or
          <strong> Replace with current filters</strong> to update it with whatever is set now.
          The funnel button shows how many filters are saved and hides or shows them.
        </p>
        <p>
          A period picked from the list, such as <em>Year to date</em>, is relative: it means the current year
          whenever the filter is applied. A custom range stays fixed. An account, category, tag or owner that
          has been deleted since the filter was saved shows as <em>missing</em> and matches nothing.
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
        <p>
          This is the transaction ledger. The search box searches by name, category, amount, date
          and more &mdash; see{' '}
          <HelpLink to="/help/searching-transactions">searching transactions</HelpLink>.
          The amount search can be used to create more complex filters than a single value. There are a
          set of pre-defined quick filters for common tasks to display only transactions which <HelpLink to="/help/reviewing-transactions">need review</HelpLink>
          or categorization, as well as selecting by other properties. The &#9662; selector picks a filter, clicking turns it on and
          off.  The filter bar and time period at the top of the page are also active. All of these combine
          to select what is visible.
        </p>
        <p>
          <strong>Bulk Edit</strong> turns the list into a selectable set, for categorizing, tagging,
          marking reviewed, trashing. <strong>Bulk Edit</strong> is also how several payments get linked
          together into a single purchase.
        </p>
        <p>*needs review*</p>
        <p>
          The &#9881; in the corner of the list picks which columns are shown. <strong>Source</strong> is the file a
          transaction was imported from, and its &#8599; opens that import. <strong>Posted</strong> is when it
          posted, where the source gives that apart from the date it was made. Columns are reordered by
          dragging a header and resized by dragging the edge between two headers. The choices are
          remembered separately for each kind of screen.
        </p>
        <p>
          The individual transaction rows support a right-click menu (press and hold on a touch screen) and &#128393; at the
          end of the row opens the transaction editor. The transaction editor also supports adding external documentation in the
          form of attachments. On a touch screen, where there is no hover, the menu&apos;s <strong>Source
          detail</strong> shows what hovering the merchant name shows.
        </p>
        <p>
          The <strong>Reimbursements</strong> button at the top of the page brings up a list of the
          un-resolved reimbursable transactions so expenses and payments can be paired. The count on the
          button and the list follow the filters set on the page.
        </p>
        <p>
          <strong>Tags</strong> opens the list of tags, where a tag is added, renamed, recolored or
          deleted (see <HelpLink to="/help/tags">how tags work</HelpLink>).
        </p>
        <h4>Markers on a row</h4>
        <p>
          Various small markers are used to convey additional information. Clicking on a marker displays
          what it refers to.
        </p>
        <ul>
          <li><strong>R</strong> &mdash; the transaction is new and <HelpLink to="/help/reviewing-transactions">needs review</HelpLink>. Clicking marks the transaction reviewed.</li>
          <li><strong>Split (N)</strong> &mdash; the amount is <HelpLink to="/help/transaction-splits">divided across categories</HelpLink>.</li>
          <li><strong>&#128279;</strong> &mdash; one of <HelpLink to="/help/multi-payment-purchases">several payments for one purchase</HelpLink>.</li>
          <li><strong>&#8617;</strong> &mdash; a <HelpLink to="/help/reimbursable-expenses">reimbursable expense</HelpLink> or its repayment.</li>
          <li><strong>&#8635;</strong> &mdash; part of a <HelpLink to="/help/recurring-transactions">recurring series</HelpLink>.</li>
          <li><strong>&#128206;</strong> &mdash; the transaction has <HelpLink to="/help/transaction-documents">documents attached</HelpLink>.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'reviewing-transactions',
    section: 'transactions',
    title: 'Needs Review',
    surfaces: ['Transactions (quick filter)', 'Import (file card)'],
    summary: 'New transactions arrive flagged needs review so they can be looked over before being trusted. The R marker, the Needs review quick filter, and bulk Mark reviewed are tools to help with this process.',
    body: () => (
      <>
        <p>
          New transactions, whether they are categorized automatically by rules or whether they land
          uncategorized, are flagged <strong>Needs review</strong> with a small <strong>R</strong> marker in a
          transaction report so they are easily identified.
          It may be worth reviewing these to catch any mistakes. Sometimes a transaction that matched a rule is
          an exception that belongs in a different category.
        </p>
        <p>
          Flagging is optional and is chosen for each account owner. Turning off <strong>Flag new transactions
            for review</strong> beside an owner, on the <strong>Owners</strong> tab of
          the <HelpLink to="/help/page-accounts">Accounts</HelpLink> page, lets transactions imported or synced
          into that owner's accounts arrive unflagged. Transactions in an account with no owner are always
          flagged. Transactions already flagged are not changed.
        </p>
        <p>The flag clears four ways:</p>
        <ul>
          <li>Editing the transaction's category clears it. Correcting or setting the category counts as reviewing it.
          </li>
          <li>
            Clicking the <strong>R</strong> marker, or <strong>Mark reviewed</strong> on the row's right-click
            menu or in the bulk-edit bar, clears it without changing anything else. This covers the common
            case where everything is correct. A single click shows an <strong>Undo</strong> for a few seconds,
            for a transaction that turns out to need checking elsewhere first, and the row stays where it is
            in the list until the <strong>↻</strong> beside the page title refreshes it, even with the Needs review filter on.
            The quick filter beside the search box, just above the transaction table, has a <strong>Needs review</strong> choice so all the transactions
            to be reviewed can be cleared at once in a bulk-edit option after the ones which needed
            editing have been dealt with. The main filter at the top of the page can be used to limit
            the display to a particular owner, account (or any other set of criteria) if only some of the entries
            should be processed.
          </li>
          <li>
            The import cards on the Import page have a pill with the number of transactions in
            the import which need review. Clicking the pill opens the import&apos;s transactions with the
            <strong>Needs review</strong> quick filter already on; the same filter turns off to show the rest of the import.
            Next to the pill is a button to <strong>mark all reviewed</strong>.
          </li>
          <li>
            A transaction a pairing takes out of the totals is cleared: the card charge for an Amazon order,
            the bank or card side of a PayPal payment, and both sides of a transfer to or from PayPal. The
            order or the PayPal payment is the transaction that counts and keeps its own flag. Unpairing puts
            the flag back.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'searching-transactions',
    section: 'transactions',
    title: 'Searching transactions',
    surfaces: ['Transactions search', 'File ledger search'],
    summary: 'The search boxes on the Transactions page and on an import card\'s ledger match names, imported text, categories, accounts, dates, amounts and the text of attached documents. Starting a search with a keyword such as merchant: or amount: limits it to one kind of match.',
    body: () => (
      <>
        <p>
          The search box above the Transactions ledger, and the one on an import card&apos;s ledger, list
          every transaction the search matches in <em>any</em> of these ways:
        </p>
        <ul>
          <li>
            <strong>Name</strong> &mdash; part of the merchant name. The name as imported keeps matching
            after a rule or a rename replaces it, so words from the bank&apos;s original description still
            find the transaction.
          </li>
          <li>
            <strong>Imported text</strong> &mdash; the description and the extra text columns an import
            captured, such as a memo or an original statement line.
          </li>
          <li>
            <strong>Item descriptions</strong> &mdash; the description given to an item of a{' '}
            <HelpLink to="/help/transaction-splits">split transaction</HelpLink>. Inside a category report
            only the item in that category is matched.
          </li>
          <li>
            <strong>Category</strong> &mdash; part of the category&apos;s name. <code>uncategorized</code> finds
            transactions without one.
          </li>
          <li>
            <strong>Account</strong> &mdash; whole words of the account&apos;s name. On their own, the words
            <em> check</em>, <em>checking</em>, <em>saving</em>, <em>savings</em>, <em>credit</em> and <em>debit</em> are
            not matched against accounts, since they would list every account of that kind;
            <code> account:checking</code> matches them.
          </li>
          <li><strong>Date</strong> and <strong>amount</strong> &mdash; described below.</li>
          <li>
            <strong>Attached documents</strong> &mdash; words in the text of an attached receipt or invoice.
            Each word matches from its start, and every word typed has to be present.
          </li>
        </ul>
        <p>
          A transaction found by text that is not on screen is marked, and hovering the mark shows where the
          search matched, with the matching text highlighted. A match in the imported text underlines the
          name with a dotted line, and hovering the name shows that text. A match in an item description
          underlines the <strong>Split (N)</strong> marker the same way, and hovering it lists the items. A
          match inside an attachment highlights the row&apos;s document marker; hovering it shows the passage
          that matched, and clicking it opens the document.
        </p>

        <HelpHeading anchor="keywords">Keywords</HelpHeading>
        <p>Starting the search with a keyword limits it to one kind of match:</p>
        <ul>
          <li><code>merchant:</code> &mdash; names only, not the imported text</li>
          <li>
            <code>raw:</code> &mdash; imported text only: the name exactly as the bank or file sent it, and
            the extra text columns the import captured. A rename or a rule&apos;s cleaned-up name is not
            matched.
          </li>
          <li><code>category:</code></li>
          <li><code>account:</code></li>
          <li><code>date:</code></li>
          <li><code>amount:</code></li>
          <li><code>doc:</code> &mdash; attached documents only</li>
        </ul>
        <p>
          <strong>Everything after the keyword is its value.</strong> <code>merchant:city water</code> searches
          names for <em>city water</em>. No quotes are needed, and quotes that are typed are searched for as
          part of the name. A search holds one keyword, and only at the very start:
          <code> +5.00 merchant:city water</code> is not an amount and a merchant, but one piece of text
          searched for as written. To narrow by a name and an amount together on the Transactions page,
          put the name in the search box and the amount in the <strong>💲 Amount</strong> filter at the top of the page.
        </p>
        <p>A keyword whose value cannot be read that way, such as <code>date:soon</code>, finds nothing.</p>

        <HelpHeading anchor="dates">Dates</HelpHeading>
        <ul>
          <li>a <strong>year</strong> &mdash; <code>2023</code></li>
          <li>a <strong>month in a year</strong> &mdash; <code>03/2023</code> or <code>2023-03</code></li>
          <li>a <strong>day</strong> &mdash; <code>03/15/2023</code>, <code>3/15/23</code>, <code>2023-03-15</code> or <code>Mar 15, 2023</code></li>
          <li>a <strong>month</strong> or <strong>month/day</strong> with no year &mdash; <code>03</code> or <code>03/15</code> &mdash; matches that date in every year</li>
        </ul>
        <p>
          The examples are month first. Numeric dates are read in the order chosen
          in <strong>Settings &rarr; Appearance</strong>, so with day first <code>15/03/2023</code> is the
          same day. A date written <code>2023-03-15</code> is read the same way in every order.
        </p>
        <p>
          A number is also tried as an amount, so <code>2023</code> finds transactions of $2,023.00 to
          $2,023.99 as well, and <code>03</code> ones of $3.00 to $3.99. <code>date:2023</code> searches dates alone.
        </p>

        <HelpHeading anchor="amounts">Amounts</HelpHeading>
        <ul>
          <li><code>42.10</code> &mdash; money paid out or received</li>
          <li><code>-42.10</code> &mdash; money paid out</li>
          <li><code>+42.10</code> &mdash; money received</li>
        </ul>
        <p>
          The dollars in an amount are exact, and the cents narrow as they are typed: <code>77</code> finds
          every amount from $77.00 to $77.99 (never $770), <code>77.4</code> those from $77.40 to $77.49,
          and <code>77.45</code> that amount alone. A dollar sign and thousands separators are fine
          (<code>$1,250.00</code>), written in the number format chosen in <strong>Settings &rarr;
            Appearance</strong> (<code>1.250,00</code> with a decimal comma), and parentheses read as a minus, the way a statement writes a payment:
          <code> (42.10)</code>. For a range of amounts, use the <strong>💲 Amount</strong> filter at the top of
          the page.
        </p>

        <HelpHeading anchor="not-searched">What is not searched</HelpHeading>
        <p>
          Tags, category groups and notes are not searched. Tags and groups are narrowed with the filter
          bar at the top of the page.
        </p>
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
        <p>*needs review*</p>
        <p>
          <strong>Split&hellip;</strong> opens the editor, from a transaction's right-click menu or its
          detail panel. On a transaction already split, clicking its <strong>Split (N)</strong> marker
          reopens it. A transaction entered by hand on <strong>+New</strong> can be split once its amount is
          entered, and is saved with its items when <strong>Add transaction</strong> is pressed.
        </p>
        <p>
          The split transaction editor reads as a small ledger &mdash; <strong>Description</strong>, <strong>Category</strong>, <strong>Amount</strong>,
          in the same order the transaction list uses. The description is optional and names what the portion
          is. Filling this in is useful as it is displayed when hovering over the
          transaction. <strong>+ Item</strong> adds another line. A split transaction needs at least two pieces.
        </p>
        <p>
          <strong>Remaining</strong> counts down as amounts are entered, and <strong>Save split</strong>{' '}
          is available once it reads <strong>Fully allocated</strong>. <strong>Add remainder to
            selected</strong> puts what is left on the current line. <strong>Distribute remainder</strong>{' '}
          spreads it across the lines in proportion to their amounts, which is one way to fold tax and
          shipping into item prices. Each can be undone.
        </p>
        <p>
          Every item has to go the same direction as the transaction, all money out or all money in, so a
          refunded item within a purchase can't be entered.
        </p>

        <HelpHeading anchor="imported-order">Splitting an imported order</HelpHeading>
        <p>
          Where the transaction came from a marketplace order whose per-item detail was imported
          (an Amazon order with its <HelpLink to="/help/amazon-import">Items file</HelpLink>), the
          editor opens with one line per item, below a list of the items and each one&apos;s share of what
          was paid. It is opened on the order&apos;s own
          transaction, the one in the Amazon account, with <strong>Split&hellip;</strong> like any
          other.
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
          item's amount, with the item&apos;s description under the merchant name. Opening the same
          transaction's detail panel shows the whole amount again. That difference is intended: one is the
          purchase, the other is the part of it that belongs to the category being looked at.
        </p>
        <p>
          Item descriptions are matched by the{' '}
          <HelpLink to="/help/searching-transactions">transaction search</HelpLink>. A{' '}
          <HelpLink to="/help/csv-export">CSV export</HelpLink> lists a split transaction once, at its full
          amount, with <code>--split--</code> in place of a category. Copying transactions to the clipboard
          lists every category the split uses.
        </p>
        <p>
          Tags behave the way they read. A tag put on the transaction applies to the whole thing and to
          every item; a tag inherited from a category follows each item's own category, so a split
          transaction can contribute to multiple tag totals. See{' '}
          <HelpLink to="/help/tags">how tags work</HelpLink>.
        </p>

        <h4>Undoing it</h4>
        <p>
          <strong>Remove split</strong> returns the transaction to the category it had before it was split.
          A split transaction's category can't be changed any other way, and{' '}
          <HelpLink to="/help/re-categorizing">rules</HelpLink> never change it.
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
    summary: 'Expenses which imply future income or which pair with existing income. Both Income and Expenses are excluded from spending. Alerts if the transaction is not closed in a reasonable time frame.',
    body: () => (
      <>
        <p>*needs review* (start at changing what is paired)</p>
        <p>
          Sometimes spending gets paid back. This can be immediately such as a dinner out with friends,
          or at a later date as with work expenses or perhaps a set of tickets bought for friends. These
          are all transactions where the spending should not be reflected as an expense and the reimbursement
          should not be reflected as income.
        </p>
        <p>
          Reimbursable expenses are created by categorizing the reimbursable portion in a category
          that is a member of the system's <em>Reimbursable</em> group. The repayment when it arrives
          is categorized into the same
          category. <strong>Reimbursable</strong> is similar to the <strong>Transfers</strong> group in that they
          are both system groups which cannot be deleted and are excluded from
          spending. Reimbursable spending implies an accompanying income transaction.
        </p>

        <h4>Reimbursable categories</h4>
        <p>
          It may be useful to name the <em>Reimbursable</em> categories so that they
          indicate <em>what the money is for</em> -- Concert tickets, Work expenses, Health care expense, etc.
          Using "Reimbursable" as a prefix (Reimbursable work expenses) makes it easy to find the expenses by
          name, although they can be located by category as well.
        </p>
        <h4>Identifying a reimbursable expense</h4>
        <p>
          A wholly reimbursable expense is categorized entirely into one of the categories in
          the <em>Reimbursable</em> group. If the
          transaction is only partially reimbursable, one ticket kept, two bought for friends, {' '}
          <HelpLink to="/help/transaction-splits">split the transaction</HelpLink> and put the reimbursable
          portion in a reimbursable category and the remainder in the appropriate spending category. Repayment
          can come from a single source such as an insurance check for a health expense or from several sources
          such as a group dinner.
        </p>

        <h4>Linking payments and expenses</h4>
        <p>
          Transactions are paired using the <strong>Reimbursements</strong> button
          on the Transactions page (and in the transaction detail report on the Categories page for a
          reimbursable category). This displays unpaired spending and income transactions from the <strong>Reimbursable</strong> category
          so they can be linked to form a reimbursement pair. Dragging a repayment to an expense pairs them. Multiple income
          transactions can be paired with a single expense. An alert is generated if spending remains
          unpaid for longer than the specified time frame; a payment received with nothing to pair it
          with raises no alert, and shows only in the count on the button.
        </p>
        <h4>Viewing outstanding reimbursements</h4>
        <p>
          The <strong>Reimbursements</strong> button lists the unpaired reimbursement and spending
          transactions from the reimbursable categories. A payment received can
          be dragged from the right onto the corresponding expense. Untracked rows represent spending
          waiting for repayment.
        </p>
        <p>
          Clicking an expected row opens its reimbursement. One not yet tracked opens unsaved, and
          becomes tracked on <strong>Save</strong> or when another transaction is linked to it; closing
          it changes nothing. Clicking a received row opens its transaction. A drop that landed on the wrong row is taken back from the <strong>Undo</strong> on the
          notice that follows it &mdash; pairing changes nothing about the transactions, so undoing it
          leaves them exactly as they were.
        </p>
        <p>
          Where more than one person is set up as an owner, each expected row starts with a chip naming
          whose account the expense is on (hovering it shows the full name), and the pills above the
          columns narrow the <strong>Expected</strong> column to one person. The page&apos;s filters narrow
          the <strong>Expected</strong> column too, tested against the expense rather than the repayment;
          {' '}<strong>Show everything</strong> drops them for the list alone. <strong>Received</strong> is
          never narrowed, since a repayment can land on anyone&apos;s account.
        </p>
        <p>
          In the transaction list a <strong>&#8617;</strong> marker on a row opens its reimbursement
          directly, dimmed once that reimbursement is finished.
        </p>

        <h4>Changing what is paired</h4>
        <p>
          In the record, <strong>&times;</strong> beside a transaction removes it, and{' '}
          <strong>Stop tracking this reimbursement</strong> removes the record. Neither changes the
          transactions themselves.
        </p>
        <p>
          While a record includes a transaction, the amount it claims has to stay in
          the <em>Reimbursable</em> group. Lowering a split's reimbursable portion below that amount,
          recategorizing the row or removing the split is refused. Removing the transaction from the
          record first frees it.
        </p>

        <h4>Being reminded about one</h4>
        <p>
          An expense still waiting for repayment stays out of spending totals, so one that is never repaid
          would understate its month. An expense outstanding too long appears on the Tasks page.
        </p>
        <p>
          <strong>Ask about anything still owed after</strong>, at the foot of
          the <strong>Reimbursements</strong> report, sets how long. It counts from the date of the
          transaction, not from when it was tracked. <strong>0</strong> turns the default off.
        </p>
        <p>
          A record can instead use its own date or have no reminder. A due record
          offers <strong>Not yet</strong>, which pushes the reminder out.
        </p>
        <p>
          Where more than one person is set up as an owner, each owner gets a separate task for the
          expenses on their accounts. Everyone can see every task.
        </p>

        <h4>Finishing one</h4>
        <p>
          <strong>Mark complete</strong> closes the record. A record repaid in full can also be completed
          from its row in the <strong>Reimbursements</strong> list. Anything else is completed in the
          record, where the money left over is given a category.
        </p>
        <ul>
          <li><strong>Repaid in full</strong> &mdash; nothing changes. The record is closed.</li>
          <li>
            <strong>Repaid short</strong> &mdash; the shortfall becomes spending on the expense, in a
            category chosen then, and counts in the expense's month.
          </li>
          <li>
            <strong>Repaid over</strong> &mdash; the surplus is categorized on the repayment, in its month.
          </li>
          <li><strong>Never repaid</strong> &mdash; the whole amount becomes spending.</li>
        </ul>
        <p>
          <strong>Reopen</strong> undoes a completion, putting back whatever it moved.
        </p>

        <h4>What the group will not allow</h4>
        <p>
          The <strong>Reimbursable</strong> group can be renamed, and its categories added, renamed and
          removed. The group itself cannot be deleted, moved inside another group, or counted toward
          spending.
        </p>
      </>
    ),
  },
  {
    id: 'transaction-documents',
    section: 'transactions',
    title: 'Attaching receipts and invoices',
    surfaces: ['Transactions (row marker)', 'Transactions (Stored documents)', 'Transaction detail (Documents)'],
    summary: 'Receipts and invoices can be attached to a transaction, or stored until the transaction arrives. Text in parsable documents is searchable from the Transactions search box.',
    body: () => (
      <>
        <p>*needs review* (starting at stored documents)</p>
        <p>
          Paperwork can be attached to a transaction. This could be to
          provide additional detail for a large or complex expense or it could be used to store receipts where they
          can be easily located if they contain interesting information.
        </p>
        <p>
          Attachments are kept in the <strong>Documents</strong> section of the transaction editor.
          Multiple documents can be attached to a single transaction. Attachments are stored in the
          documents directory under the directory holding the transaction database.
        </p>
        <p>
          A row with attachments is flagged with a document marker. Clicking it displays the document.
        </p>

        <h4>Attaching a document</h4>
        <p>
          Documents can be attached directly to a transaction using the transaction editor or
          they can be uploaded via the <strong>Stored documents</strong> button on the Transactions page.
          There are several ways to provide a document:
        </p>
        <ul>
          <li>
            <strong>Drop a file</strong> onto the box, or pick one with <strong>Browse&hellip;</strong>.
          </li>
          <li>
            <strong>Paste an image</strong> -- a screenshot or a photo already on the clipboard.
          </li>
          <li>
            <strong>Paste text</strong> from the clipboard. Pasted text can be trimmed before it
            is stored.
          </li>
        </ul>
        <p>
          In the transaction editor a stored document can be selected with
          the <strong>Stored documents (N)</strong> button.  The button only appears when there are stored documents.
        </p>
        <p>
          Using copy/paste with an email usually brings its HTML formatting along, so an itemized table keeps
          each price beside its item. The formatted preview can be edited in place -- click into it to cut a
          signature, quoted replies or blank space -- and what it shows is what gets attached.
          <strong>Convert to plain text</strong> turns it into plain text instead, at the cost of the table
          layout; <strong>Discard and return to HTML</strong> undoes that. A careful text selection keeps
          anything extraneous out of the attachment.
        </p>

        <h4>Stored documents</h4>
        <p>
          An invoice or receipt often arrives before its transaction has been imported. Instead of
          finding it again later, it can be stored with <strong>Stored documents</strong> on the
          Transactions page, which accepts documents the same ways the Documents section does. A document
          added on its own opens its name for editing, since the name is what identifies it when it is
          attached later. The button shows how many documents are waiting.
        </p>
        <p>
          Once the transaction arrives, open it and use <strong>Stored documents (N)</strong> in its
          Documents section to pick the document and attach it. A stored document's text is not
          searchable from the Transactions page until it is attached.
        </p>

        <h4>Renaming and removing documents</h4>
        <p>
          The pencil beside a document renames it, and <strong>Edit</strong> changes the text of a plain-text
          document. There are two ways to take a document off a transaction:
        </p>
        <ul>
          <li>
            <strong>&times;</strong> moves it to the stored documents. Use this for a document attached to
            the wrong transaction; it can be attached to the right one from there.
          </li>
          <li>
            The <strong>trash can</strong> deletes the document permanently, after a confirmation.
          </li>
        </ul>
        <p>
          Stored documents are deleted the same way, from the Stored documents dialog.
        </p>

        <h4>What is accepted, and scaling</h4>
        <p>
          PDFs, images, plain text, HTML files, and saved email.
          Large photographs are scaled down -- a receipt shot at twelve megapixels carries
          nothing legible above roughly 300 DPI -- and
          the original is not kept. Screenshots and small images pass through untouched.
          A generous per-file size limit exists to stop
          a pathological scan, not to ration space.
        </p>
        <p>
          Attaching the same file to the same transaction twice is reported rather than stored twice, and
          so is storing a file that is already stored.
        </p>

        <h4>Searchable attachments</h4>
        <p>
          Searchable text is generated from:
        </p>
        <ul>
          <li>PDFs carrying a text layer</li>
          <li>HTML files</li>
          <li>exported <code>.eml</code> email files</li>
          <li>anything pasted or uploaded as text</li>
        </ul>
        <p>
          There is no OCR capability, so
          text cannot be extracted from a <em>photograph</em> of a receipt. Pictures are
          stored and viewable, but not findable by their contents.
        </p>
        <p>
          Text found in an attachment is searched by the search box on the Transactions
          page. Search results where the match is from an attachment are flagged so it is clear why
          they matched even though the search term is not visibly present, and hovering the flag shows
          the passage that matched.
          Starting the search with the <code>doc:</code> keyword narrows it to only the attachments. See{' '}
          <HelpLink to="/help/searching-transactions#keywords">searching transactions</HelpLink>.
        </p>

        <h4>Storage</h4>
        <p>
          Documents follow their transaction into the trash and come
          back intact if the transaction is restored from the trash. When the trash is emptied, any associated
          documents are destroyed (deleted off disk). Stored documents are not in any transaction, so they
          stay until they are attached or deleted.
        </p>
        <p>
          Attached files are stored as individual files in a directory next to the database file rather
          than inside the database. Attachments are included in backups along with the transactions that
          reference them -- so a backup taken after attaching a receipt contains the receipt. See{' '}
          <HelpLink to="/help/backup-restore">Backup / Restore</HelpLink>.
        </p>
      </>
    ),
  },
  {
    id: 'page-categories',
    section: 'categories',
    title: 'Categories and groups',
    surfaces: ['Categories'],
    summary: 'Categories are assigned to transactions and organized into groups. These are used for reporting.',
    body: () => (
      <>
        <p>
          The category tree has two levels. Transactions are assigned to
          a <strong>category</strong> and categories are organized into <strong>groups</strong>. Groups can
          be marked <strong>Exclude from totals</strong>, or assigned a tag, and these propagate
          to the transactions assigned to the group's categories. Tags can also be assigned to
          individual categories. Dashboard reports work at both the group and category level.
        </p>
        <p>
          When a category is removed, if it is not empty, the transactions are reassigned
          to another category or marked uncategorized. Deleted categories are kept in the <strong>Inactive</strong> list
          at the bottom of the page. This acts as a local trash for categories and
          entries can be restored or purged from the list. The <strong>Delete empty</strong> button
          removes empty categories.
        </p>
        <p>
          Categories are optional. Apart from transactions which should be excluded from the totals and
          reimbursable expenses, categories are only used for reporting and can be ignored if that is not
          of interest.
        </p>
        <h4>System groups</h4>
        <ul>
          <li>
            <strong>Unassigned</strong> holds categories that were learned from imported transactions
            which have not been sorted into a
            reporting group yet. <HelpLink to="/help/imported-category-cleanup">Group imported categories</HelpLink> is
            where these categories get assigned to groups or deleted.
          </li>
          <li>
            <strong>Transfers</strong> holds categories related to money movement and by default
            is marked with <HelpLink to="/help/exclude-from-totals">Exclude from totals</HelpLink> turned on.
            This is used by the import logic which pairs spending transactions between accounts (a payment
            to PayPal to fund a PayPal purchase, a credit card payment to clear the charges from the month's
            transactions) so it cannot be deleted or moved
            inside another group. It can be renamed, and exclude from totals can be turned off.
          </li>
          <li>
            <strong>Reimbursable</strong> holds <HelpLink to="/help/reimbursable-expenses">categories for money
              expected to be paid back</HelpLink>. It cannot be deleted or moved. Unlike
            Transfers, its exclusion cannot be turned off.
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
        <p>
          Adding an excluded group or category to the filter brings it back into the dashboard reports,
          which gives a report on just the transfers or just the reimbursable expenses. Tag, account and
          payee filters do not. Both directions are counted, so a transfer between two accounts in the
          ledger nets to zero and reimbursable expenses net to what is still owed. Setting the
          <strong> 💲 Amount</strong> filter to debits shows just the money paid out.
        </p>

      </>
    ),
  },
  {
    id: 'tags',
    section: 'categories',
    title: 'How tags work',
    surfaces: ['Transactions (Tags)'],
    summary: "Tags are labels for reporting and filtering applied at the transaction, category, group, and account level. A transaction's effective tags are the union of all four sources.",
    body: () => (
      <>
        <p>
          Tags are lightweight labels separate from the category tree. Use them to identify any group
          of transactions which is interesting to report or filter on. <em>Household spending</em> for example
          might have expenses across categories beyond the Household expense group. It might be
          interesting to examine <em>Essential</em> expenses vs everything else. Tags can also be
          used as placeholders to build complicated 'and' and 'or' expressions beyond what can be done
          with the filter.
        </p>
        <p>
          A tag can be attached at four levels, and a transaction's <strong>effective
            tags</strong> are the union of all four:
        </p>
        <ul>
          <li><strong>Direct (transaction-level)</strong> &mdash; added by a rule or
            manually. Manual edits, which can add or remove a tag, override the rule for that row.</li>
          <li><strong>Category-level</strong> &mdash; a tag attached to a category propagates
            to every transaction in that category.</li>
          <li><strong>Group-level</strong> &mdash; a tag attached to a category group propagates to
            every transaction in any of the group's categories. A transaction can override an
            inherited tag, but while a category in a group can add tags of its own, it cannot
            override anything inherited from the group.</li>
          <li><strong>Account-level</strong> &mdash; a tag attached to an account (on the Accounts
            page) propagates to every transaction in that account. For a merged account the top-level
            account's tags carry to its child accounts' transactions, while a merged child's own tags
            stay dormant until it is detached. Merging accounts offers to add the merged child's tags
            to the parent.</li>
        </ul>
        <p>
          Composing across levels is fine. The same tag can be on a group, an account and
          on individual transactions. The expectation is that a tag comes from multiple
          sources and/or is applied by one or more rules.
        </p>
        <p>
          To hide an inherited tag on a single transaction, uncheck it in that transaction's tag
          picker (the row's tag popover or the transaction editor). A strike-through <strong>hidden here</strong> entry
          remains in the picker and can be checked to restore it. Removing a tag from the
          category, group, or account drops it from every transaction that inherited it from that level.
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
    summary: 'Rules match incoming transactions and make changes: adding a category, adding a tag, setting a merchant name, marking it to be included in a recurring series, or raising an alert.',
    body: () => (
      <>
        <p>
          A rule has <strong>matching conditions</strong> to select the transactions it applies to
          and <strong>actions</strong> to apply. Transactions can be selected by the merchant field,
          owner, associated account, account-type and amounts. Actions can set the merchant name,
          assign a category or tags, mark the transaction as part of a recurring series, or raise an
          alert. Rules run against newly imported data.
        </p>
        <p>
          The matching on the merchant field can involve phrases as well as 'and' and 'or' conditions. Only a
          single 'and' can be used and all 'or' conditions are evaluated first so the supported pattern is
          (a or b or c) and d where a,b,c, and d can be phrases. Rules match the
          text as it arrived from the source. Rules never match against something which was
          changed since it arrived (either manually or by a rule). In addition to matching the
          merchant field mapped during the import, the stored raw text can be included if desired.
        </p>
        <HelpHeading anchor="how-rules-come-into-being">Creating rules</HelpHeading>
        <p>
          There are three main ways rules get created:
        </p>
        <ol>
          <li>
            Importing data where the transactions have already been carefully categorized. When importing
            transactions from a file, the bottom of the mapping screen has an option to import transactions
            with their current categorization and to bring in the categories from the file and use the
            categorization in the file to propose matching rules. This can also be specified after the
            file has been imported (or cleared if it was a mistake). <strong><HelpLink to="/help/generate-rules">Generate rules</HelpLink></strong> describes
            how to bring in the rules based on a file.
          </li>
          <li>
            When a transaction is categorized {APP_NAME} offers to build a rule matching the action.
            The rule can be edited and applied to other matching transactions when it is saved.
            From then on it runs automatically against newly imported data.
          </li>
          <li>
            Marking a transaction in the ledger as part of a recurring series launches the Rules editor
            as a manually created recurring series is built by creating a rule that indicates it is
            part of a series.
          </li>
        </ol>
        <p>
          If starting fresh, with no historical data to learn from, there is a small <strong>starter
            set</strong> of common categories and rules that can be added via buttons on the Rules and Category pages.
          Rules alter the data, so the starter rules are shown as a list for approval before adding.
        </p>
        <HelpHeading anchor="rule-alerts">Alerts</HelpHeading>
        <p>*needs review*</p>
        <p>
          An alert posts a task when a matching transaction arrives in an import or sync, which is useful
          for activity that should not happen, such as charges on a closed card. The task shows the
          message given in the rule, or describes the rule when there is none. Transactions already in the
          ledger never raise an alert, so applying the rule or running <strong>Categorize</strong> does not
          post one.
        </p>
        <p>
          A rule with no merchant keyword matches every transaction on its account, owner or account type,
          so an alert on a closed card needs only the card's account and, if wanted, debits only.
        </p>
        <HelpHeading anchor="applying-rules">Manually applying rules, and rule checkups</HelpHeading>
        <p>
          <strong>Categorize</strong> re-applies the rules across the ledger without overwriting
          anything set by hand. <HelpLink to="/help/re-categorizing">When rules are applied</HelpLink> contains details
          regarding which rows are allowed to touch.
        </p>
        <p>
          <strong>Rule checkup</strong> scans the set of rules to report problems which may
          exist involving rules that compete with each other. With rules there is a precedence for
          which rule is applied when multiple rules match a transaction. For instance there might be
          a rule to cover "Visa credit card payment" and then a 2nd one for just "card payment". When one rule
          contains another (also possible with amount ranges) the more specific rule is evaluated first,
          the longer rule in this case. If however the two rules were "Visa" and "card payment", if a merchant
          string comes in with "Visa card payment", two rules match but their strings are not overlapping so this
          is an ambiguous case. The rule checkup reports on ambiguous cases. It also reports if
          there are two rules with overlapping matching conditions and the same set of actions (e.g. the
          more restrictive rule is harmless but not needed).
        </p>
      </>
    ),
  },
  {
    id: 're-categorizing',
    section: 'rules',
    title: 'When rules are applied',
    surfaces: ['Rules page'],
    summary: 'Rules are applied as transactions arrive, and again on request.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>Rules are applied in two situations, as transactions arrive and after certain user actions.
        </p>
        <h4>As transactions arrive</h4>
        <p>
          The routine situation is that rules get applied automatically as transactions arrive. Each imported or synced
          transaction runs through the rules -- the same process triggered by
          the <strong>Categorize</strong> button on the Rules page. This is optional for CSV file imports controlled
          by the <strong>Apply categorization rules on import</strong> option which defaults to on.
        </p>
        <p>
          If <strong>Import the transactions with their existing categories</strong> is checked, the categories in the file are
          imported for use and the transactions are imported with their categorization in the file.
          This is generally done as part of an initial seeding from another tool, not with every imported file.
          Rules still take precedence, the file's category fills in only rows which are not covered
          by an existing rule. When there are no rules, all the categorized transactions retain their
          categories. As rules are added, this starts to change and rules added later can claim
          rows which were imported with their category from the file.
        </p>
        <h4>Categorize</h4>
        <p>
          The <strong>Categorize</strong> button on the Rules page runs every rule across the whole
          ledger. Run it after adding or changing rules. A category or name set by hand is kept, while
          the rule&apos;s other actions still apply: a rename where the name was not typed by hand, and
          its tags. A tag removed from a transaction by hand stays removed. Categorize never removes a
          category, so a transaction that no longer matches any rule keeps the one it has.
        </p>
        <h4>Applying a rule when it is saved</h4>
        <p>
          Saving a rule offers <strong>Apply this rule now to N matching existing transactions</strong>.
          Unlike Categorize, this also overrides what was set by hand: the category, the name, and a rule
          tag removed by hand. A charge moved to money movement by an Amazon order or a PayPal pairing
          keeps its category, and so does a refund; both still take the rename and tags.
        </p>
        <h4>Changing an account&apos;s owner or type</h4>
        <p>
          Rules can be limited to an owner or an account type, so changing either on an account re-applies
          the rules to its transactions, the same way Categorize does.
        </p>
        <h4>Undoing a rule's categorizations</h4>
        <p>
          When a rule turns out to be wrong, deleting or editing it offers to <strong>re-evaluate</strong> the
          transactions it categorized. Each one goes to another matching rule, back to the category from
          its imported file, or to uncategorized.
        </p>
        <p>
          A <HelpLink to="/help/transaction-splits">split transaction</HelpLink>&apos;s category is never
          changed by a rule, since its categories are the items it was divided into. A rule&apos;s rename
          and tags still apply.
        </p>
        <p>
          A transaction's edit panel shows <strong>manual</strong> beside a category set by hand, and
          its <strong>Categorized by</strong> line says where the category came from.
        </p>
      </>
    ),
  },
  {
    id: 'rule-precedence',
    section: 'rules',
    title: 'When two rules match the same transaction',
    surfaces: ['Rules page'],
    summary: 'Which rule wins when more than one matches a transaction, and how Rule checkup finds the cases where the winner is arbitrary.',
    body: () => (
      <>
        <p>
          When multiple rules match a single transaction, the
          <strong> most specific</strong> rule wins, ranked in the following order based on what they match: a rule scoped by owner
          beats one that is not, then a rule pinned to an account, then account type,
          then the <strong>longer keyword</strong>, and last the <strong>narrower amount range</strong>.
          The order matters as much as the terms -- scope is settled before keyword length, and keyword
          length before amount. A rule with several text strings combined with an 'or' counts only its shortest one, since each
          spelling it adds lets it match more transactions, not fewer.
        </p>
        <p>
          Narrower on the amount axis means the <em>smaller range</em>, not the rule with more limits
          set. A rule for charges over $3,000 matches strictly fewer transactions than one for charges
          over $300, so it wins wherever both apply.
        </p>
        <p>
          A range that sits entirely inside another is the way to split one merchant's charges across
          categories by amount. The inner range wins where both match.
        </p>
        <h4>Low priority</h4>
        <p>*needs review*</p>
        <p>
          A rule's <strong>Priority</strong> can be set to <strong>Low</strong>, in the rule editor or
          from Rule checkup. A low-priority rule gives way to every normal rule matching the same
          transaction, ahead of all the terms above. It is meant for a generic rule whose text turns up
          inside other merchants' descriptions, such as <em>electronic payment</em>, so the other rules
          don't need longer keywords to outrank it.
        </p>
        <h4>Rule checkup</h4>
        <p>
          <strong>Rule checkup</strong> on the Rules page lists pairs of rules that compete for the same
          transactions, each section with a short explanation, and either rule can be opened for editing
          from there. It also lists{' '}
          <HelpLink to="/help/rule-amount-drift">charges that have drifted out of a rule's range</HelpLink>.
        </p>
        <p>The findings are either <strong>to settle</strong> or <strong>for information</strong>.</p>
        <ul>
          <li>
            <strong>Amount ranges that overlap</strong> and <strong>Rules that match the same
              transaction</strong> are to settle: which rule wins is arbitrary. Narrow one rule's keyword
            or range, or set the more generic rule to low priority. These can't be dismissed, and an
            import, sync or Categorize that runs into one also raises a task on the Tasks page.
          </li>
          <li>
            <strong>A low-priority rule losing to a broader one</strong> is also to settle. It is usually
            a priority set on the wrong rule.
          </li>
          <li>
            The rest are for information: the more specific rule wins, which is usually what was
            intended. Where one rule of a pair changes nothing, the report offers to delete it, and it
            can be restored from the rules trash.
          </li>
        </ul>
        <p>
          A finding that is fine as it is can be dismissed, and <strong>Show dismissed</strong> brings it
          back. A rule edit that changes the finding lists it again.
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
    surfaces: ['Import (rule suggestions)'],
    summary: 'Generate rules proposes rules that reproduce the categories in an imported file on future transactions. When one merchant is filed under several categories, its suggestions form a conflict set.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          If the data comes from another tool where the transactions already carry meaningful categories,
          tell {APP_NAME} the import's category data is useful (check <strong>Import the transactions with their
            existing categories</strong> on the file's card). {APP_NAME} keeps that categorization on the imported transactions, adds new categories to
          the pool of categories to be grouped by <strong>Group imported categories</strong>, and <strong>Generate rules</strong> analyzes them to propose rules that reproduce the
          same categorization on future, uncategorized data.
        </p>
        <p>
          The result is rules. The imported rows are already categorized and mostly stay as they are. Two
          things here do change them: accepting a suggestion applies its rule, including any edits made to
          it first, to the rows that produced it, and resolving a conflict can re-categorize rows.
        </p>
        <p>Each suggested rule can be:</p>
        <ul>
          <li><strong>Saved</strong>, after editing it if needed.</li>
          <li><strong>Deferred</strong>, to decide later.</li>
          <li>
            <strong>Discarded</strong>, with one of two choices under <strong>discard and&hellip;</strong>:
            <ul>
              <li>
                <strong>keep categorization</strong> leaves the rows as imported. This is for a file
                category that is right but not worth a rule, such as an annual fee filed under its own
                category.
              </li>
              <li>
                <strong>remove categorization</strong> clears the rows' category so rules can categorize
                them later. This is for a file category that was wrong or messy.
              </li>
            </ul>
          </li>
        </ul>
        <p>
          Deferring an accepted suggestion, or returning it to pending, undoes the accept: the rule it
          created goes to the trash and its rows return to the categories they had before.
        </p>

        <h4>Conflict sets</h4>
        <p>
          When the same merchant was filed under <strong>several different categories</strong>, one rule
          can't reproduce all of them, so those suggestions are grouped into a <strong>conflict
            set</strong>. Opening the set shows the competing categories and the matching rows. There are
          three ways to resolve one:
        </p>
        <ul>
          <li><strong>Narrow the rules so they no longer overlap.</strong> Add an owner, account or amount
            condition to each rule, so each covers its own share of the merchant's transactions.</li>
          <li><strong>Pick one category for the merchant.</strong> The matching-transactions list can
            re-categorize the rest in bulk, which leaves one rule. This corrects the file's category, so
            the rows still count toward the suggestions.</li>
          <li><strong>Keep an outlier as a one-off.</strong> <strong>Preserve This Categorization</strong> sets the row's
            category by hand. It drops out of the suggestions, and Categorize leaves it alone.</li>
        </ul>
        <p>
          <strong>No conflicts</strong>, in the bulk actions bar, hides the suggestions in conflict sets,
          so <strong>Select all</strong> picks up only the straightforward ones.
        </p>

        <h4>Older suggestions</h4>
        <p>
          A suggestion whose newest matching transaction is older than the <strong>Look back</strong>{' '}
          window moves from <strong>Pending</strong> to the <strong>Older</strong> pill, since a merchant
          with no recent activity is unlikely to recur. Widening the window brings them back. They can be
          left alone, or selected together and settled with <strong>Discard, keep categories</strong> or{' '}
          <strong>Discard, clear categories</strong>, which work like the single Discard choices.
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
    title: 'The Accounts page',
    surfaces: ['Accounts'],
    summary: 'Accounts, Owners and Connections. Transactions identify the account they came from, owners are matched to accounts for reporting, and connections feed accounts from a data provider.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          <strong>Accounts</strong> are created during the import process. The various sources of transaction data tend to
          either supply account information with the transaction or all the transactions are from a single
          account and the user identifies that account when the data is imported.
        </p>
        <p>
          The <strong>Connections</strong> tab is where a <HelpLink to="/help/data-providers">data
          provider</HelpLink> is linked and maintained, including which account each of the
          provider&apos;s accounts feeds. <strong>Sync now</strong> pulls new transactions from every
          connection, and what each sync brings in joins the import history on the Import
          page&apos;s Data Import tab &mdash; <strong>View in import history</strong>, on a finished
          sync, opens the cards it added to.
        </p>
        <p>
          <strong>Balance</strong> is what an account holds, or owes as a negative amount. One on the unusual
          side for its type is colored: red below zero on a bank or investment account, green above zero on a
          card or loan, and either on a wallet, which normally holds nothing. It starts from
          the latest balance its connection reported or that was entered by hand, dated beneath it, and adds
          the posted transactions dated after that. The date is highlighted when no newer balance has come
          for a week from a connection, or 35 days for one entered by hand, which is marked (m). Clicking a balance, or the dash where there is none, or <strong>Edit balance…</strong> in the
          row&apos;s &#8943; menu, enters one by hand, for an account with no connection or to set one right. A merged group has one balance, from
          whichever member reported most recently. The account&apos;s &#8599; report shows the balance after
          each transaction, counted in the order of the date the list is sorted by, with a day&apos;s credits
          before its debits as banks post them. Its &#9881; adds a <strong>Posted</strong> column; sorted by
          that, the list and its balances match a bank&apos;s own listing. The report also lists any stretch
          between two stated balances whose change the transactions in it don&apos;t add up to; the last
          transaction in that stretch is marked &#9888;, since one is missing, extra or wrong there. <strong>Exclude</strong> keeps an account out
          of net worth; an account of type <em>Other</em> is always out.
        </p>
        <p>
          Bringing in data from the individual spending accounts &mdash; credit cards, P2P, loan accounts &mdash; is
          usually worth it, since they carry the richest transaction detail; a bank account on its own
          represents a month of card purchases a single payment. When both the payment account and the
          actual purchase accounts are
          imported, the category that <em>credit-card payment</em>s are filed under belongs in a group
          marked <HelpLink to="/help/exclude-from-totals">Exclude from totals</HelpLink> (the
          supplied <em>Transfers</em> group ships that way) so the spending is not counted twice. Where
          that detail is not interesting, the bank account alone is enough.
        </p>
        <p>
          Accounts may end up with different identifiers in the transaction data. This can occur when
          transaction data comes from different sources and when a new credit card is issued. There are two
          ways this can be handled. During the import the new account can be mapped to the existing account and
          the transactions will be associated with that account. Alternatively, a new account can be created and
          merged with the existing account on the Account
          page <HelpLink to="/help/merging-accounts">merged</HelpLink>. Merged accounts can be detached if
          needed which re-evaluates the transactions which were discarded as same-account duplicates.
        </p>
        <p>
          <strong>Owners</strong> are assigned to accounts. When more
          than one owner exists, <em>shared</em> becomes available as a choice. Owner can be filtered
          and reported on and used in the selection criteria for rules. Each owner also chooses whether its new
          transactions arrive flagged <HelpLink to="/help/reviewing-transactions">needs review</HelpLink>.
          Each user can also <HelpLink to="/help/owner-lens">show only their own owners</HelpLink>.
        </p>
      </>
    ),
  },
  {
    id: 'owner-lens',
    section: 'accounts',
    title: 'Showing only some owners',
    surfaces: ['Owner view (top-right corner)'],
    summary: 'A setting, kept for each user, that limits the Dashboard, Transactions, Accounts, Rules, Recurring and Tasks pages to chosen owners.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          The <strong>Owner view</strong> switch in the top-right corner of the Dashboard, Transactions,
          Accounts, Rules, Recurring and Tasks pages limits them to the transactions, accounts, rules and
          recurring series that belong to the chosen owners. The &#9662; opens the list of owners, hovering
          shows who is included, and &rsaquo; folds the tab down to the switch. Each user has their own choice.
        </p>
        <p>
          A rule or recurring series belongs to every owner whose transactions it matches, so a rule two people
          share shows for both. One that has not matched anything yet shows for everyone. <em>Unassigned</em>
          stands for accounts with no owner and can be included or left out. On the Tasks page the counts for
          uncategorized transactions, reimbursements and recurring findings follow the view; the other tasks
          are about the whole ledger.
        </p>
        <p>
          The owner view only changes what is shown. A rule created while it is on still applies to everyone's
          transactions unless the rule is given an owner.
        </p>
      </>
    ),
  },
  {
    id: 'merging-accounts',
    section: 'accounts',
    title: 'Merging accounts to reconcile',
    surfaces: ['Accounts page'],
    summary: 'Merging records that two accounts are the same real account, and settles the duplicates between them.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          Merging says two accounts are the same real account, such as one card named differently by two
          sources. To merge, drag one account onto the other on the Accounts page. Only accounts of the
          same type can be merged, and dragging onto one that can't be merged says why. Dragging a merged
          account out to the top level detaches it.
        </p>
        <p>
          A transaction both accounts hold, described the same way by both sources, is{' '}
          <HelpLink to="/help/removed-as-duplicates">removed as a duplicate</HelpLink>. One described
          differently stays on the <HelpLink to="/help/duplicate-report">duplicate report</HelpLink> for
          review. The result is the same whether the accounts are merged before or after the import.
        </p>
        <p>
          Detaching puts back the duplicates the merge removed. Decisions made on the duplicate report,
          such as <strong>Discard new</strong> or <strong>Replace existing</strong>, are kept.
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
        <p>*needs review*</p>
        <p>
          A <strong>recurring series</strong> is a transaction that repeats on a schedule -- a subscription, a
          bill, a paycheck. These may have a fixed amount or the amount may vary in a range.
        </p>

        <h4>Found automatically</h4>
        <p>
          A <strong>scan</strong> looks across recent history for transactions which arrive on a regular rhythm.
          The signal is <em>regularity of timing</em>, not frequency. A punctual once-a-year tax is
          recognized; a busy merchant paid at random is not. The scan runs on
          its own after an import or an edit to a transaction, and can be run on demand from the Recurring
          page. If one of those automatic scans cannot finish, a task reports that recurring detection is
          out of date until a later scan catches up.
        </p>
        <p>
          Amount is a hint, not a gate, unless matching by amount is turned on (see <em>Which transactions
            belong</em>). A utility bill that changes every month still qualifies, because it arrives on a
          schedule. Transactions are grouped by payee <em>and</em> category, so one biller
          with several obligations -- a town charging property tax quarterly and water monthly -- becomes
          individual series rather than one muddled one.
        </p>
        <p>
          A newly found series is a <strong>suggestion</strong> for review. Confirm the ones that are correct; mark the
          rest <strong>Not recurring</strong> and they will not be proposed again.
        </p>

        <h4>When the scan cannot see it</h4>
        <p>
          The scan groups by payee name, so a merchant whose name arrives in several spellings looks like
          several payees. When rules rename those transactions to one standardized name, that is the name
          the scan sees, and the series is found.
        </p>
        <p>
          A charge already known to recur does not have to wait for the scan. When creating a rule for it
          -- after categorizing the transaction, or from <strong>Mark as recurring…</strong> --
          turn on <strong>Recurring series</strong>. Every transaction the rule matches becomes a member of
          the series, and later matches join as they arrive. To change which transactions belong, edit the rule.
        </p>
        <p>
          A one-off that does not warrant a rule can still be added by hand from the Recurring page.
        </p>

        <h4>Which transactions belong</h4>
        <p>*needs review*</p>
        <p>
          Which transactions belong is worked out again on every scan, from what currently matches.
        </p>
        <p>
          <strong>Remove from recurring series</strong>, in a transaction's right-click menu, takes out one
          the scan swept in by mistake, and it stays out after later scans. An <strong>Amount
            changed</strong> finding offers the same thing as <strong>Exclude from series</strong>.{' '}
          <strong>Restore to recurring series</strong>, in the same menu, or the <strong>removed</strong>{' '}
          list inside the series, puts it back.
        </p>
        <p>
          A transaction can't be added to a series it doesn't match. To bring one in, correct its merchant
          name or widen the rule that defines the series.
        </p>
        <p>
          <strong>Matching by amount.</strong> A series normally ignores amount. When one payee bills two
          things in the same category that only the amount tells apart, such as two subscriptions at
          different prices, the <strong>Amount</strong> button on the series card limits the series to
          charges near the amounts it has charged, or to a range set by hand. A series defined by a rule
          has no Amount button; the rule's amount condition does the same job.
        </p>
        <p>
          A transaction in a series carries a small ↻ marker, and its editor links to the series.
        </p>

        <h4>Transfers between two accounts</h4>
        <p>
          A transfer or credit-card payment between two tracked accounts arrives as two transactions. The
          scan pairs them by amount (the same amount in opposite directions, a few days apart) rather than
          by name, and treats them as one series naming both accounts. That keeps a payment made for years
          as one series even when the banks change how they describe it. A transfer to or from an account
          not tracked here is an ordinary series.
        </p>
        <p>
          A paired transfer takes its transactions out of any series matched by name. A series defined by a
          rule keeps everything its rule matches.
        </p>
        <p>
          When more than one transaction could be the other half, nothing is paired, and the transfer is
          listed under <strong>Transfers to match</strong> in <strong>Needs attention</strong>. Choosing the
          right one settles it. <strong>Dismiss</strong> leaves it matched by merchant name. Either answer can
          be taken back from the resolved list at the foot of the view.
        </p>

        <h4>What needs attention</h4>
        <p>
          The Recurring page has three views, chosen from the selector under its title: the
          <strong> Series</strong> list itself, <strong>Needs attention</strong>, and <strong>Upcoming</strong>. The count beside
          <strong> Needs attention</strong> is how many findings are open, including any transfers to match.
        </p>
        <ul>
          <li>
            <strong>Missing charge</strong> -- an occurrence is overdue. Lateness is
            measured against how current the data is rather than against the calendar.
            After a couple of missed cycles the series is treated as probably canceled, and
            <strong> Mark ended</strong> is offered as an option. Nothing is ended automatically.
          </li>
          <li>
            <strong>Amount changed</strong> -- a charge that differs from what the series normally charges.
            See <em>When an amount changes</em> below.
          </li>
          <li>
            <strong>Newly detected</strong> -- a series found for the first time in the last month.
          </li>
        </ul>
        <p>
          Opening the <em>series report</em> on a finding opens the related transactions in a panel below the
          findings, without leaving the list being worked through. <strong>Details</strong> under a finding shows the
          series card itself -- cadence, amount setting, range, and the last and next dates -- with the same
          controls as the series list.
        </p>
        <p>
          Dismissing a finding covers that one
          finding only -- a later missed cycle, or a different charge, is reported again. Anything
          dismissed or answered is listed under <strong>resolved</strong> at the foot of the view and can be
          brought back.
        </p>
        <h4>When an amount changes</h4>
        <p>
          An <strong>Amount changed</strong> finding means the latest charge differs from what the series
          normally charges. What counts as a change depends on the series:
        </p>
        <ul>
          <li>
            <strong>Fixed price</strong> (a subscription) -- a change of about 15% or more from the last few
            charges.
          </li>
          <li>
            <strong>Varying amount</strong> (gas, electricity, water) -- a charge well outside anything the
            series has charged recently.
          </li>
        </ul>
        <p>
          A change is reported once. When the next charge arrives at the same new amount, it is treated as
          the new normal and nothing more is reported -- unless the first finding was dismissed as a
          one-off.
        </p>
        <p>
          Each finding offers a choice, depending on what the charge is:
        </p>
        <ul>
          <li>
            <strong>Dismiss</strong> -- the amount is correct. The finding is hidden and the charge stays in
            the series. On a bill whose amount varies, dismissing also teaches the series that the amount is
            normal: a heating bill that peaks every January is reported the first winter, and once dismissed,
            later bills up to that amount pass quietly while a higher one is still reported. Restoring the
            dismissed finding takes that amount back out. On a fixed price, dismissing accepts that the price
            went up, and a further increase is reported as usual.
          </li>
          <li>
            <strong>Dismiss as one-off</strong> -- the amount is correct this time, but the usual amount still
            stands: a price increase the merchant agreed to reverse, or a single promotional month. The
            finding is hidden and the charge stays in the series, but later charges are compared with the
            amounts before it. A return to the usual amount passes quietly; the same higher amount arriving
            again is reported again. On a bill whose amount varies, a one-off does not teach the series a
            new normal.
          </li>
          <li>
            <strong>Accept new amount</strong> -- offered only on a series with matching by amount turned on.
            It widens the series' amount range to include the new price. Without it, later charges at the new
            price are not matched to the series. A series defined by a rule never offers it: there the amount
            range belongs to the rule, and a charge outside it is reported on the Rules page.
          </li>
          <li>
            <strong>Exclude from series</strong> -- the charge does not belong, such as a one-off purchase
            from the same merchant. The charge is taken out of the series and stays out after future scans;
            the transaction itself is unchanged. This covers that one charge only. If more charges like it
            keep arriving, the series is matching too broadly, and the fix is under <em>Which transactions
              belong</em> above.
          </li>
        </ul>
        <p>
          An excluded charge can be put back from the prompt that appears, from its right-click menu
          (<strong>Restore to recurring series</strong>), or from the <strong>removed</strong> list inside the series.
        </p>

        <h4>What is coming up</h4>
        <p>
          The <strong>Upcoming</strong> view lists the charges due in the next month with what they are expected
          to cost. Nothing there is wrong, so it carries no actions, no dismissal, and never
          appears on the Tasks page -- it is there to be consulted, not resolved. It sits alongside
          <strong> Needs attention</strong> rather than inside it for that reason.
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
          <HelpLink to="/help/re-categorizing">when rules are applied</HelpLink>.
        </p>
      </>
    ),
  },
  {
    id: 'page-import-export',
    section: 'importing',
    title: 'The Import page',
    surfaces: ['Import'],
    summary: 'Where transactions come in. The Data Import tab takes files and syncs and keeps a card per file or sync recording what it did. File Sources is where a file\'s mapping is kept.',
    body: () => (
      <>
        <p>*needs review*</p>
        {/* A map of the page rather than a prose tour: the page carries more topics than any other, and
            what a reader wants here is which control leads to which one. Grouped by tab, since the tabs
            are how the page itself is divided. */}
        <p>
          Where transactions come in. The page has two tabs, and the sections
          below follow them: each row names something on the page, says what it is for, and links the
          topic that explains it.
        </p>
        <p>
          Importing the same activity twice is safe. Every import is compared against what is already in
          the ledger, the clear duplicates are settled without asking, and whatever needs a decision waits
          in the file card&apos;s duplicate-detection report.
        </p>

        <HelpHeading anchor="import-tab">Data Import</HelpHeading>
        <div className="help-table-scroll">
          <table>
            <thead>
              <tr><th>On the page</th><th>What it is for</th></tr>
            </thead>
            <tbody>
              <tr>
                <td>The file drop area</td>
                <td>Bringing in a CSV file. A mapping screen follows: which columns hold the date, the
                  amount and the description, <HelpLink to="/help/amount-conventions">how the file
                    represents money in and out</HelpLink>, and which account the rows belong to. For a file
                  that mixes currencies, mapping its currency column keeps rows in any other currency out
                  of the ledger; they are listed with the file&apos;s rejected rows instead. For a bank
                  export with a running balance, mapping its balance column records the account&apos;s
                  balance at the close of each day the file covers, which net worth counts from; undoing
                  the import removes them. The file&apos;s order and whether it states a card&apos;s balance
                  as what is owed are read from the file.</td>
              </tr>
              <tr>
                <td><strong>Data connections</strong></td>
                <td>Shown once a <HelpLink to="/help/data-providers">data provider</HelpLink> is
                  connected. <strong>Sync now</strong> pulls new transactions from every connection,
                  and <strong>Connections</strong> lists each one with when it last synced and anything
                  waiting on it. Connecting and mapping are on the Accounts page&apos;s Connections tab.</td>
              </tr>
              <tr>
                <td><strong>Watched folders</strong></td>
                <td>Shown once a data source watches a folder. Lists the files a{' '}
                  <HelpLink to="/help/watched-folders">watched folder</HelpLink> could not import on
                  its own, each with the reason, and <strong>Check now</strong> looks for new files
                  immediately.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          A finished import brings the card for the file just imported into view in the import history,
          and the drop area is ready for the next file.
        </p>

        <HelpHeading anchor="history-tab">Import history</HelpHeading>
        <p>
          Under the drop area on the Data Import tab: every import and sync, grouped by where it came
          from: a saved data source, Amazon, a connection,
          or <HelpLink to="/help/unknown-data-source">no saved source</HelpLink>.
        </p>
        <div className="help-table-scroll">
          <table>
            <thead>
              <tr><th>On the page</th><th>What it is for</th></tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>Group imported categories</strong></td>
                <td>Sorting the categories a file brought with it into groups, and removing the unwanted
                  ones &mdash; see <HelpLink to="/help/imported-category-cleanup">learning categories from
                    imported transactions</HelpLink>.</td>
              </tr>
              <tr>
                <td><strong>Generate rules</strong></td>
                <td>Proposing rules from a file that is already categorized, so future imports are filed
                  the same way &mdash; see <HelpLink to="/help/generate-rules">generating rules</HelpLink>.</td>
              </tr>
            </tbody>
          </table>
        </div>

        <HelpHeading anchor="file-cards">A file&apos;s card</HelpHeading>
        <p>
          Each imported file gets a card in the import history; a connection&apos;s syncs are filed
          on cards by month.
        </p>
        <div className="help-table-scroll">
          <table>
            <thead>
              <tr><th>On the card</th><th>What it is for</th></tr>
            </thead>
            <tbody>
              <tr>
                <td>The duplicate pills</td>
                <td>Opening <HelpLink to="/help/duplicate-report">the duplicate-detection report</HelpLink>,
                  where <HelpLink to="/help/cross-account-duplicates">cross-account
                    matches</HelpLink> and <HelpLink to="/help/covered-range-review">covered-range
                      matches</HelpLink> are decided.</td>
              </tr>
              <tr>
                <td>The &#8599; button</td>
                <td>The transactions the file brought in, with a search box of its own
                  (see <HelpLink to="/help/searching-transactions">searching transactions</HelpLink>) and,
                  at the top, how many rows were <HelpLink to="/help/removed-as-duplicates">removed as
                    duplicates</HelpLink>.</td>
              </tr>
              <tr>
                <td>The needs-review count and <strong>Mark all reviewed</strong></td>
                <td>Looking over what just arrived, or clearing the flag for the whole file &mdash;
                  see <HelpLink to="/help/reviewing-transactions">needs review</HelpLink>.</td>
              </tr>
              <tr>
                <td><strong>Undo</strong></td>
                <td>Removing the import along with everything it changed.</td>
              </tr>
            </tbody>
          </table>
        </div>

        <HelpHeading anchor="amazon-tab">Amazon</HelpHeading>
        <p>
          Marketplace orders arrive in their own shape and are matched against card charges already in
          the ledger. The order and item files are dropped on the Data Import tab like any other file;
          they are recognized by their contents and open the Amazon import form.
        </p>
        <div className="help-table-scroll">
          <table>
            <thead>
              <tr><th>On the page</th><th>What it is for</th></tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>File(s) to import</strong></td>
                <td>The order and item files exported from Amazon &mdash;
                  see <HelpLink to="/help/amazon-import">importing Amazon order detail</HelpLink>.
                  {' '}<strong>Add file(s)</strong> brings in the other file of a pair.</td>
              </tr>
              <tr>
                <td><strong>Import into account</strong>, <strong>Payment cards in these files</strong> and
                  {' '}<strong>Category for matched card charges</strong></td>
                <td>Where the orders go and which of the ledger&apos;s accounts each payment card is &mdash;
                  see <HelpLink to="/help/amazon-funding-sources">the Amazon import page</HelpLink>.</td>
              </tr>
              <tr>
                <td>An Amazon card with orders needing review</td>
                <td>Opening <HelpLink to="/help/amazon-reconciliation">the reconciliation
                  report</HelpLink>, which lines orders up with card charges and resolves the unclear
                  ones.</td>
              </tr>
              <tr>
                <td>The outcome pills on an Amazon card</td>
                <td>What that import actually did &mdash; see <HelpLink to="/help/amazon-import-detail">the
                  Amazon import detail report</HelpLink>.</td>
              </tr>
            </tbody>
          </table>
        </div>

        <HelpHeading anchor="sources-tab">File Sources</HelpHeading>
        <p>
          The <HelpLink to="/help/unknown-data-source">saved data sources</HelpLink>, each
          with its rename, <strong>Folder</strong>, <strong>Edit</strong> and delete controls.
          Saving a file&apos;s mapping as a data source means the next file from the same place
          needs none of the mapping again, and <strong>Folder</strong> has the data source import
          from a <HelpLink to="/help/watched-folders">watched folder</HelpLink> on its own. Amazon is
          listed here as well; it has no mapping to edit.
        </p>
      </>
    ),
  },
  {
    id: 'data-providers',
    section: 'importing',
    title: 'Data providers and connections',
    surfaces: ['Accounts (Connections)', 'Import (Data Import → Data connections)'],
    summary: `A data provider is an online service that fetches transactions directly from some source of interest.`,
    body: () => (
      <>
        <p>
          A <strong>data provider</strong> is an online service that retrieves transactions from various sources
          so they arrive in {APP_NAME} without exporting and importing a file. The
          supported providers are <strong>Plaid</strong> and <strong>SimpleFIN Bridge</strong>. There are
          no credentials supplied in {APP_NAME}. SimpleFIN Bridge is a subscription model and provides access to most
          financial institutions. Plaid offers a developer license which allows
          a limited number of account connections to be built.
        </p>
        <p>
          The <strong>data provider</strong> defines the model. With SimpleFIN Bridge, the accounts are
          connected on the SimpleFIN Bridge webpage and the <strong>provider connection</strong> provides the transaction data from
          all of the connected accounts. For Plaid, the Plaid webpage has the secrets and after they are
          entered, <strong>Institutions</strong> are connected in {APP_NAME} and that process defines
          the accounts which will provide data.
        </p>
        <p>
          Transactions from <em>data providers</em> go through the the same duplicate
          detection process as file imports and the transaction record lives on the
          Import page organized by Month rather than file.
        </p>
        <p>
          Syncing is a manual process; there is no facility for a scheduled or automatic sync
          as the vault which holds the secrets can only be unlocked manually.
        </p>
        <p>
          Data connections are established and managed on the <strong>Connections</strong> tab on
          the <strong>Accounts</strong> page. Account mapping and Disconnect are on the per-connection
          menu.
        </p>
        <h4>Secrets Vault</h4>
        <p>
          Provider and account connection credentials are encrypted in
          the <HelpLink to="/help/credential-vault">credential vault</HelpLink>. To get started with
          data connections use <strong>Set vault passphrase</strong> on the Connections tab. The vault
          has to be unlocked to connect or sync.
        </p>
        <h4>Connecting</h4>
        <p>
          Perform the needed setup and configuration on the data provider end.
        </p>
        <ul>
          <li>
            <strong>Plaid</strong> &mdash; needs app credentials from a Plaid account, entered once
            with <strong>Configure</strong> by an administrator. Once it is configured, use the <strong>+Connect Institution</strong> button
            to connect accounts.
          </li>
          <li>
            <strong>SimpleFIN Bridge</strong> &mdash; needs a one-time setup token generated at SimpleFIN Bridge.
            Institutions and accounts are configured on the SimpleFIN Bridge side.
          </li>
        </ul>

        <h4>Connecting and mapping accounts</h4>
        <p>
          Part of the connection process is mapping the accounts from the provider to accounts in
          the application. Provider accounts can be skipped if they are not of interest. The
          correct mapping is what allows duplicate detection to work properly across different
          import methods. It is fine to import CSV files when there are data connections, as long
          as the transactions all map to the same account from both sources.
        </p>
        <p>
          The mapping can be changed from <strong>Account mapping&hellip;</strong> in the card's menu;
          for a provider with optional details to capture or a choice of live balances (Plaid), the entry
          is <strong>Connection settings&hellip;</strong> and covers those as well. An account added at the
          provider later has to be mapped as well (see <em>When a connection needs attention</em> below).
        </p>
        <p>
          Clicking a connection's name renames it, on the <strong>Connections</strong> tab, on the <strong>Data Import</strong> tab's
          connections card, or on its heading in the import history. The new name is shown everywhere the
          connection is named, its import cards included; useful when two connections come from the same
          provider. Clearing the name goes back to the one the provider reports.
        </p>

        <h4>Syncing</h4>
        <p>
          New transactions are pulled on request using the sync control in the navigation pane or
          from <strong>Sync now</strong> on the Import page&apos;s <strong>Data Import</strong> tab or the
          Accounts page&apos;s <strong>Connections</strong> tab. Per-connection Import cards on the Import page records
          what arrived, similar to an imported file. Importing a file generates a single card, the
          data connections create a card for the <strong>Initial import</strong> and then one
          per month.
        </p>
        <p>
          Each connection carries a menu with the following actions:
        </p>
        <ul>
          <li>
            <strong>Fetch more history</strong> &mdash; pulls older transactions as far back as the bank and provider allow.
          </li>
          <li>
            <strong>Refresh accounts</strong> &mdash; rebuilds the connection's account list from its
            stored credential. Needed when a restore brings back a connection's credential without
            its accounts, which is reported on the <strong>Tasks</strong> page (see{' '}
            <HelpLink to="/help/backup-restore#restoring">restoring a backup</HelpLink>).
          </li>
          <li>
            <strong>Remove synced transactions</strong> &mdash; deletes everything the connection has
            synced so the next sync imports it again. This is the equivalent of Undo on a
            file card.
          </li>
        </ul>
        <p>
          If a provider limits the time window for each request and limits the number
          of requests per day, retrieving the initial
          transaction history may take more than one day. The sync
          reports <strong>more history to fetch</strong> and more will be fetched when the
          limit refreshes. The initial sync stops before exhausting the provider's limit to
          allow for subsequent fetches of the most recent data while waiting for the limits to
          refresh. Hovering a connection's last-synced time shows the requests left.
        </p>

        <h4>When a connection needs attention</h4>
        <p>
          A connection with an action required indicates this on its card and on the Tasks
          page.
        </p>
        <ul>
          <li>
            <strong>Reconnect needed</strong> means
            the provider no longer accepts the stored credential, usually because access was revoked or
            expired at the provider, or that no credential is stored at all, which is how a vault reset
            or a restore without the credentials leaves a connection. Syncing stays stopped until it is
            connected again, and <strong>Sync now</strong> passes over a connection with no credential.
            For one with no credential, <strong>+ Connect</strong> with the choice to replace that
            connection puts the new credential on it, keeping its accounts and history.
          </li>
          <li>
            A <strong>provider notice</strong> is a problem the provider reported that did not stop the
            sync, such as one bank on a multi-bank connection needing attention.
          </li>
          <li>
            <strong>To map</strong> means an account was added at the provider after the initial
            mapping. Its transactions are skipped until it is mapped
            from <strong>Account mapping&hellip;</strong> (or <strong>Connection settings&hellip;</strong>)
            in the card's menu, or by clicking the count.
          </li>
          <li>
            *needs review* A bank re-linked at the provider can return its accounts as new ones. Mapping a
            new one onto the Luma account the old one fed replaces the old one: a Luma account is fed by one
            provider account, so the old one is set to skip and leaves the mapping screen. Where both were
            mapped before this was enforced, the next sync settles them on whichever one the provider still
            reports. Mapping two new accounts onto one Luma account in the same save is refused.
          </li>
          <li>
            Transactions with nowhere to go are counted as <strong>No destination</strong> in
            the <strong>Sync log</strong>, with the provider accounts they came from named below the count.
          </li>
          <li>
            A sync that did not complete is reported with what the provider said in
            the <strong>Sync log</strong>, which separates a bank being briefly unavailable from
            something that needs fixing.
          </li>
          <li>
            A connection with no accounts has its credential and nothing to import into, which is how
            a restored backup can leave it. <strong>Refresh accounts</strong> in the card's menu fetches
            the list.
          </li>
        </ul>

        <h4>Disconnecting</h4>
        <p>*needs review*</p>
        <p>
          Disconnecting keeps the accounts and their transactions. For a Plaid account connection the
          confirmation offers <strong>Revoke and remove</strong>, which ends the connection at Plaid, or{' '}
          <strong>Remove from this install only</strong>, which leaves it in place there.
        </p>
        <p>
          <strong>Remove Configuration</strong> in <strong>Configure</strong> removes every Plaid account
          connection, with the same two choices, and then deletes the Plaid client ID and secret from {APP_NAME}.
        </p>
        <p>
          If Plaid refuses to revoke a connection, for instance after the client ID and secret were changed
          to another environment, the connection is kept and <strong>Remove anyway</strong> is offered.
        </p>
      </>
    ),
  },
  {
    id: 'credential-vault',
    section: 'importing',
    title: 'The credential vault',
    surfaces: ['Accounts (Connections, the vault strip)'],
    summary: 'The vault encrypts the data provider credentials stored on disk. It is opened with a passphrase or a passkey, and has to be open to connect or sync.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          The vault encrypts the{' '}
          <HelpLink to="/help/data-providers">data provider</HelpLink> and account connection credentials
          stored on disk.
          Nothing else is encrypted: transactions, accounts, categories and rules are not in the vault
          and are not affected by anything done to it. The vault has to be open to connect a provider
          or to sync. Everything else in {APP_NAME} works with it locked.
        </p>
        <p>
          The strip at the top of the <strong>Connections</strong> tab shows the state of the vault and
          what can be done next.
        </p>
        <div className="help-table-scroll">
          <table>
            <thead>
              <tr><th>On the strip</th><th>What it is for</th></tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>Set vault passphrase</strong></td>
                <td>Shown before a vault exists. The passphrase has to be strong. The dialog rates it as
                  it is typed, says what would make it stronger, and can suggest one. Several unrelated
                  words work well.</td>
              </tr>
              <tr>
                <td><strong>Your vault passphrase is considered too easy to guess</strong></td>
                <td>The strength rule has become stricter since the passphrase was set. It still opens
                  the vault, but data providers cannot be connected, and backups leave out the
                  credentials, until it is changed in Vault settings. Only the person whose passphrase it
                  is can change it.</td>
              </tr>
              <tr>
                <td><strong>Validate passphrase</strong></td>
                <td>Shown after the strength rule changes. The passphrase has to be typed once so it can be
                  checked; a passkey cannot be checked. Until then, backups leave out the
                  credentials.</td>
              </tr>
              <tr>
                <td><strong>Unlock with a passkey</strong></td>
                <td>Appears once a passkey has been added in Vault settings.</td>
              </tr>
              <tr>
                <td><strong>Lock</strong></td>
                <td>Closes the vault now. It also locks after eight hours without use, and when the
                  application restarts. Each browser unlocks separately.</td>
              </tr>
              <tr>
                <td><strong>Request vault access</strong></td>
                <td>Shown when someone else has already created the vault. The request sets a passphrase,
                  and someone who can already open the vault approves it in{' '}
                  <HelpLink to="/help/vault-settings">Vault settings</HelpLink>.</td>
              </tr>
              <tr>
                <td><strong>Can't open it?</strong></td>
                <td>Lists the ways back in after a forgotten passphrase. The last resort rebuilds the
                  vault, which keeps the ledger and every connection's account mapping, but every
                  connection has to be reconnected. It asks whether the passphrase was forgotten or may
                  have been exposed, and works with the vault locked either way. After an exposure, a
                  provider's app secret, such as Plaid's, also has to be replaced at the provider.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </>
    ),
  },
  {
    id: 'vault-settings',
    section: 'importing',
    title: 'Vault settings',
    surfaces: ['Vault settings (Accounts, Connections)'],
    summary: 'How the vault is opened, who else can open it, and what to do when a passphrase or a copy of the database may have been exposed.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          <strong>Vault settings</strong> opens from the strip at the top of the Connections tab while
          the <HelpLink to="/help/credential-vault">credential vault</HelpLink> is unlocked. A change
          to how the vault opens needs the passphrase or a passkey presented within the last five
          minutes, so some of the controls ask for it again.
        </p>

        <HelpHeading anchor="unlock-methods">Unlock methods</HelpHeading>
        <p>
          The passphrase, and any number of passkeys. Any one of them opens the vault. A passkey is
          added per device and is the convenient everyday unlock; the passphrase stays as it was. The
          last remaining method cannot be removed. Clicking a passkey&apos;s name renames it
          in {APP_NAME}; the name in the device&apos;s own passkey list was set when it was added and
          does not change.
        </p>
        <p>
          A vault passkey is separate from a passkey used to sign in to {APP_NAME} (see{' '}
          <HelpLink to="/help/account-security">account security</HelpLink>). Neither does the
          other&apos;s job.
        </p>

        <HelpHeading anchor="recovery-code">Recovery code</HelpHeading>
        <p>
          A one-time code that opens the vault and sets a new passphrase. Nothing is reconnected
          afterwards, and a fresh code is issued in place of the one used. It matters most when only
          one person can open the vault, since a forgotten passphrase then has no other way back.
        </p>
        <p>
          The code is shown once and is not stored. Keep it somewhere other than where the passphrase
          is kept: stored together, the two are lost together. <strong>Replace code</strong> issues a
          new one and the old one stops working.
        </p>

        <HelpHeading anchor="vault-access">Vault access</HelpHeading>
        <p>
          The people who can open the vault, and anyone waiting to be approved. Approving shares the
          key that decrypts the provider credentials and nothing else, since the ledger is already
          shared. A request marked <strong>lost their passphrase</strong> comes from someone who
          already had access and is asking for it back under a new passphrase; it is worth checking
          with that person before approving. <strong>Remove access</strong> is available to an
          administrator. Removing the last person with access, or deleting their user, resets the vault:
          the stored credentials are cleared and any data sources need reconnecting. Deleting that user
          warns first; to keep the credentials, set a vault passphrase and have them approve it before
          deleting them.
        </p>

        <div className="help-box">
          <HelpHeading anchor="resolving-problems">Resolving problems</HelpHeading>
          <div className="help-table-scroll">
            <table>
              <thead>
                <tr><th>Situation</th><th>What to do</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td>The passphrase or a passkey may have been seen or copied</td>
                  <td>
                    <ol style={{ marginBottom: 0 }}>
                      <li>Change or remove it under <strong>Unlock methods</strong>, which retires the
                        unlock method.</li>
                      <li><strong>Replace vault key&hellip;</strong>, which retires the key it could
                        reach.</li>
                    </ol>
                  </td>
                </tr>
                <tr>
                  <td>Someone should no longer be able to open the vault</td>
                  <td>
                    <ol style={{ marginBottom: 0 }}>
                      <li><strong>Remove access</strong>.</li>
                      <li><strong>Replace vault key&hellip;</strong>.</li>
                    </ol>
                  </td>
                </tr>
                <tr>
                  <td>The database or a backup may have been copied</td>
                  <td>Follow the steps
                    in <HelpLink to="/help/copied-database">if the database or a backup is
                      copied</HelpLink>, which start at <strong>Respond to an exposure</strong>.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <HelpHeading anchor="replace-key">Replace the vault key</HelpHeading>
        <p>
          Generates a new key and re-encrypts every stored credential under it, so a copy of the old
          key stops being useful. The unlock methods are unchanged, and the vault locks in every other
          running session.
        </p>
        <p>
          The confirmation asks why. Replacing the key <em>to end someone's access, or after an
            exposure</em> stops earlier backups restoring the data provider credentials unless the person
          restoring chooses to. A <em>routine</em> replacement leaves earlier backups as they were.
        </p>

        <HelpHeading anchor="exposure">Respond to an exposure</HelpHeading>
        <p>
          For when the database or a backup may have been copied. <strong>Replace connection
            credentials&hellip;</strong> has each provider issue a new account connection credential
          where it supports that, and lists what is left to replace at the provider. It is the first step
          of <HelpLink to="/help/copied-database">responding to a copied database</HelpLink>.
        </p>
        <HelpHeading anchor="erase">Erase the vault</HelpHeading>
        <p>
          *needs review* Shown to an administrator once nothing is stored in the vault: no account
          connection credential and no data provider app secret. It deletes every member&apos;s unlock
          methods, and setting a passphrase afterwards starts a new vault. Backups taken before still
          restore the credentials they hold.
        </p>
      </>
    ),
  },
  {
    id: 'csv-export',
    section: 'transactions',
    title: 'Exporting transactions to CSV',
    surfaces: ['CSV export (Settings)', 'Copy transactions (Download CSV)'],
    summary: 'A CSV export writes the transactions matching a filter, with the chosen columns, in roughly the shape they were imported. It is not a backup: splits, tags, rules and attachments stay behind.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          <strong>CSV export</strong> on the <HelpLink to="/help/page-settings#data">Settings</HelpLink> page
          writes the transactions matching a filter to a CSV file, one row per transaction, with the
          columns ticked below the filter. The filter starts as a copy of the one set on the Transactions
          page, and changing it leaves that one as it was. With no filter set, every transaction is
          written. For a list too large to copy, the <strong>Copy transactions</strong> dialog on the
          Transactions page offers the same file as <strong>Download CSV</strong>.
        </p>
        <p>
          A CSV export gives the data back roughly as it was imported, with some of the work done since
          &mdash; renames, categories, notes. It cannot carry all of it, and is not a way to move or keep
          the data: a <HelpLink to="/help/backup-restore">backup</HelpLink> is.
        </p>
        <p>
          Text starting with <code>=</code>, <code>+</code>, <code>-</code> or <code>@</code> is written
          with a <code>'</code> in front, so a spreadsheet shows it as text rather than running it as a
          formula. Merchant names and payment notes are written by others, and a formula can fetch web
          addresses when the file is opened.
        </p>

        <h4>Split transactions</h4>
        <p>
          A row holds one category, and a{' '}
          <HelpLink to="/help/transaction-splits">split transaction</HelpLink> has several. An export
          therefore lists a split once, at its full amount, with <strong>Category</strong> and{' '}
          <strong>Group</strong> reading <code>--split--</code>. An empty cell would say the transaction
          is uncategorized, which it is not. Item descriptions are not exported.
        </p>
        <p>
          Filtered to a category, the export lists the items in that category instead, each at its own
          amount and under its own category &mdash; the same rows the category report shows.
        </p>
      </>
    ),
  },
  {
    id: 'unknown-data-source',
    section: 'importing',
    title: 'Saved data sources (import file profiles)',
    surfaces: ['Import (File Sources)', 'Import history'],
    summary: 'Imported files not linked to a saved mapping are listed under "unknown data source" or "temporary draft". A data source is a saved mapping which is useful if other files with the same format (e.g. from the same source) will be imported later.',
    body: () => (
      <>
        <p>
          A <strong>data source</strong> is a saved template of the settings from the
          import mapping screen describing the fields and account mapping. Imported files
          are organized in the import history on the Data Import tab by data source. If there will be future
          imports from the same data source it is useful to save the mapping so it does not
          need to be recreated each time. A file lands under <strong>unknown data source</strong> or a <strong>temporary
            draft</strong> when it isn't linked to a data source.
        </p>
        <p>
          The saved mapping can be created during the import or afterwards from
          the file&apos;s row in the import history.
        </p>
        <p>
          The <strong>Data sources</strong> list on the File Sources tab allows for editing, deleting
          and can also be used to create new data sources. Deleting a data source does not remove any
          files, just the mapping template.
        </p>
        <p>
          A data source can also watch a folder, so a file saved there is imported without a visit to
          the drop area. <strong>Folder</strong> on the data source&apos;s row sets it up &mdash;
          see <HelpLink to="/help/watched-folders">importing from a watched folder</HelpLink>.
        </p>
        <h4>Account mappings</h4>
        <p>*needs review*</p>
        <p>
          For a data source whose files name the account on each row, each import remembers which
          account every value in that column goes to, or that it is skipped. Editing the data source
          lists those under <strong>Account mappings</strong>, where a value can be pointed at another
          account, given a new account with <strong>+New</strong>, or skipped. Files from a watched
          folder never pass through the mapping screen, so this is where their mappings are changed. A new
          account is created when the data source is saved, and every value needs an account or Skip
          before it can be. A value not listed is asked about at its next import, and a watched folder
          holds that file for review.
        </p>
        <h4>Transaction IDs</h4>
        <p>*needs review*</p>
        <p>
          Some exports give every transaction its own ID, in a column headed something
          like <em>Id</em> or <em>Transaction ID</em>. Mapping that column (<strong>Transaction
            ID</strong> on the mapping screen) lets each later file from the same data source recognize
          the transactions already imported, even when a description has been reworded or an amount
          has changed &mdash; a tip added after a charge settled, for instance, corrects the amount in
          place instead of adding a second copy. A second identical charge with a different ID is
          imported as the separate transaction it is. PayPal files are read this way without any
          mapping.
        </p>
        <p>
          The IDs are compared only with transactions imported through the same data source, so this
          works best with one data source per provider. When a provider changes the columns in its
          export, continue with the existing data source rather than creating a new one; it takes on
          the new layout. Transactions imported before the provider added an ID column receive their
          IDs when the first file carrying the column is imported, and importing an older file without
          the column afterwards changes nothing.
        </p>
        <p>
          Where an export also names, on a refund, the ID of the payment it returns &mdash; a column
          headed something like <em>Reference Txn ID</em> &mdash; capturing that column pairs the two:
          the refund takes the payment&apos;s category and follows it, so the two cancel out there
          rather than the refund counting as income somewhere else. The payment must be in the same
          account group, in the other direction, and for at least what came back. Nothing is guessed
          from amounts and dates; only a reference the file states pairs anything.
        </p>
        <p>
          When one provider&apos;s files have ended up under two data sources, delete one of them: its
          files move to <strong>unknown data source</strong>, and <strong>Assign to data
            source</strong> on each file card places them under the other.
        </p>
      </>
    ),
  },
  {
    id: 'watched-folders',
    section: 'importing',
    title: 'Importing from a watched folder',
    surfaces: ['Import (Watched folders)', 'Import (File Sources → Folder)'],
    summary: 'A data source can watch a folder instead of waiting for a file to be dropped on the import page. Files placed there are imported on the next visit; anything the saved mapping cannot answer on its own is left for review rather than guessed at.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          A monthly export usually follows the same route every time: download the file, open the import
          page, pick the data source, import. A <strong>watched folder</strong> removes the middle of
          that. The <strong>Folder</strong> button on a data source's row on the <strong>File
            Sources</strong> tab takes a directory; a CSV that appears in it is imported the next time the app
          is opened, and arrives in the import history as an ordinary file card with the usual duplicate,
          rejected-row and rule-suggestion review on it.
        </p>
        <p>
          The PayPal data source also takes PayPal&apos;s monthly statement PDFs, so one folder can hold
          both its activity downloads and its statements. A statement goes into the account earlier
          statements for the same PayPal account went into, so the first statement for each PayPal
          account is imported by hand, where that account is chosen. A zip of statements is not opened
          from a folder; drop it on the import page instead.
        </p>
        <p>
          The folder is read on the machine that runs the application. On a desktop installation that is
          the same machine the page is open on. On a server, or in a container, it is a folder there
          &mdash; a container additionally needs any folder outside its data folder mounted, or the path
          names nothing.
        </p>
        <p>
          Every installation has an <code>imports</code> folder beside its data, which is always one that
          can be watched and is where <strong>Browse</strong> starts. A server watches only there and
          inside the folders its operator names with <code>WATCH_FOLDER_ROOTS</code> in its{' '}
          <code>.env</code> file. The account the server runs as has to be able to read the folder and the
          files saved into it, and to delete them there when a data source deletes files after import.
        </p>
        <p>
          <strong>Browse</strong> walks that machine&apos;s folders rather than this one&apos;s, which is
          what makes a path on a server findable without knowing it in advance. Each folder lists the
          files it holds that this source would import, below its subfolders, since seeing last
          year&apos;s export sitting in a folder is what says it is the right one. The path can still be
          typed instead &mdash; a network share the picker cannot reach is named that way. Choosing a
          folder on the server needs an administrator, as setting the path does.
        </p>
        <h4>Proving the setup first</h4>
        <p>
          A data source imports on its own only after one of its files has been imported by hand. The
          mapping screen is where a source learns which account each value in the file belongs to, so
          until one file has been through it there is nothing for an unattended import to apply. Set the
          source up, import one export the usual way, then point it at the folder. An Amazon source has
          no mapping to learn, so it starts with the first file in its folder.
        </p>
        <h4>Files left for review</h4>
        <p>
          Anything the saved mapping cannot answer is listed under <strong>Watched folders</strong> on
          the Import page, with the reason beside it, and a task points at the same list.{' '}
          <strong>Import&hellip;</strong> opens that file in the ordinary import flow with the data source
          already applied, so the question gets answered once and the file imports.{' '}
          <strong>Dismiss</strong> stops reporting a file without touching it, until the file itself
          changes.
        </p>
        <p>
          Every reason is the same kind of thing &mdash; a decision that belongs to a person rather than
          to a scan:
        </p>
        <ul>
          <li>an account value the data source has never been shown, or one whose account has since been
            deleted or moved to the trash. A watched folder never creates an account and never matches one
            by name: a wrong guess splits an account's history without saying so</li>
          <li>a data source set up to create a new account as part of importing. Saving the data source
            from its editor creates the account</li>
          <li>a file whose columns are not the ones the data source expects, which usually means a file
            from somewhere else landed in the folder</li>
          <li>a PayPal statement for a PayPal account with no statement imported yet, or a PDF that is not
            a PayPal statement</li>
        </ul>
        <p>
          A file or folder the server cannot read is fixed on the server, by giving it to the user the
          server runs as. A folder that cannot be read imports nothing, and a task names it until the next
          check can read it again.
        </p>
        <p>
          The fix is made wherever it belongs &mdash; pointing a value whose account was deleted at
          another one under <strong>Account mappings</strong> when editing the data source on the{' '}
          <strong>File Sources</strong> tab, for instance. The next check picks the file up on its own and the task
          clears itself; the file does not need touching.
        </p>
        <h4>What happens to the files</h4>
        <p>
          Nothing, unless the data source says otherwise. <strong>Once a file is imported</strong> offers
          keeping every file, deleting one a set number of days after it was imported, or deleting it as
          soon as it is imported. Only a file whose contents still match what was imported from it is
          ever deleted, so a file replaced under the same name is left in place and reported. A file that
          cannot be deleted is reported too, rather than passed over quietly.
        </p>
        <h4>When the check happens</h4>
        <p>
          Folders are checked when the app is opened and when the Import page is opened, at most
          about once an hour, and <strong>Check now</strong> checks immediately. A file is left for the
          following check the first time it is seen, so a download still being written is never read
          half-finished.
        </p>
        <p>
          Restoring a backup taken on a different machine switches watching off and keeps the paths, since
          those paths belong to the other machine. Each such source shows <strong>Use here</strong> and{' '}
          <strong>Clear</strong>, and a task lists them until each is answered. <strong>Use here</strong>{' '}
          watches the same path on this machine, and is refused while that folder is not there;{' '}
          <strong>Clear</strong> removes it. Choosing a different folder with <strong>Folder</strong>{' '}
          answers it too.
        </p>
      </>
    ),
  },
  {
    id: 'amount-conventions',
    section: 'importing',
    title: 'Specifying how amounts are represented',
    surfaces: ['Import mapping', 'Data source editor'],
    summary: 'Specify how the file represents money in vs out: a single signed column, an amount column plus a separate debit/credit "type" column, or separate debit and credit columns. Also whether it writes decimals with a point or a comma.',
    body: () => (
      <>
        <p>*needs review*</p>
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
          The <strong>decimal separator</strong> is how the file writes a number: a point
          (<em>1,234.56</em>) or a comma (<em>1.234,56</em>). It is suggested from the file. A value that
          is not a well-formed number in the chosen style is not imported, and the mapping preview shows
          it as written rather than as an amount.
        </p>
        <p>
          Amounts are all in one currency, chosen on the Settings page &mdash;
          see <HelpLink to="/help/single-currency">single-currency support</HelpLink>.
        </p>
      </>
    ),
  },
  {
    id: 'purchase-detail',
    section: 'importing',
    title: 'Adding purchase detail from Amazon and PayPal',
    surfaces: ['Import (Data Import)'],
    summary: 'A card or bank line for a marketplace purchase names the marketplace and an amount. The marketplace\'s own export says what was bought, and is worth importing whether the card arrives by file or by data connection.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          A card or bank line for a marketplace purchase says only <strong>AMAZON.COM</strong> or
          PAYPAL and an amount, whether a file or a{' '}
          <HelpLink to="/help/data-providers">data connection</HelpLink> brought it in. The
          marketplace&apos;s own export says what was bought, and is worth importing alongside either.
        </p>
        <ul>
          <li>
            <strong>Amazon</strong> &mdash; the Orders file from the AZAD browser extension, and
            optionally the Items file for the same period
            (see <HelpLink to="/help/amazon-import">importing Amazon order detail</HelpLink>). It adds
            one transaction per order, in an Amazon account. With the Items file it also adds each
            order&apos;s items, so the order can be split across categories.
          </li>
          <li>
            <strong>PayPal</strong> &mdash; the monthly statement PDFs (or a zip of them), or the
            activity CSV (see <HelpLink to="/help/paypal-statements">PayPal statements</HelpLink>).
            Either adds one transaction per PayPal payment, naming who was paid. The CSV adds the item
            title; the statements pair each refund with its payment.
          </li>
        </ul>
        <p>The steps are the same for both:</p>
        <ol>
          <li>
            <strong>Export</strong> the period wanted. The first time that is the whole history worth
            having; afterwards the recent months.
          </li>
          <li>
            <strong>Drop the files</strong> on the <strong>Data Import</strong> tab. They are recognized
            by their contents. The first import asks which account the purchases go into and, for
            Amazon, which account each payment card is
            (see <HelpLink to="/help/amazon-funding-sources">the Amazon import form</HelpLink>).
          </li>
          <li>
            <strong>Check the reconciliation.</strong> Each order or wallet payment is matched with the
            card or bank transaction that paid for it, and that transaction is moved out of the totals
            so the purchase counts once. The import&apos;s card says when a match needs a decision
            &mdash; see <HelpLink to="/help/amazon-reconciliation">Amazon
              reconciliation</HelpLink> and <HelpLink to="/help/wallet-reconciliation">wallet
                reconciliation</HelpLink>.
          </li>
          <li>
            <strong>Use the detail.</strong> The order or PayPal transaction is the one to categorize.
            An Amazon order with item detail opens in the split editor with one line per item, and{' '}
            <strong>Use items</strong> fills them in &mdash; see{' '}
            <HelpLink to="/help/transaction-splits#imported-order">splitting an imported
              order</HelpLink>.
          </li>
        </ol>
        <p>
          Overlapping exports are safe, and so is importing before the card or bank account that paid:
          matching runs again when that side arrives.
        </p>
      </>
    ),
  },
  {
    id: 'amazon-import',
    section: 'importing',
    title: 'Importing Amazon order detail (AZAD Chrome extension)',
    surfaces: ['Import (File Sources → Amazon)'],
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
          If this file is imported, an order holding items of different kinds can be split across
          categories with the items already listed &mdash; see{' '}
          <HelpLink to="/help/transaction-splits#imported-order">splitting an imported order</HelpLink>.
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
            Check <strong>Show totals in CSV downloads</strong>. The other fields are optional.
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
              present the <HelpLink to="/help/transaction-splits#imported-order">split editor</HelpLink> opens with
              one line per item, and <strong>Use items</strong> fills in the amounts from the items file.
            </p>
          </li>
          <li>Repeat for each year you want to bring in.</li>
        </ol>
        <p><strong>Loading the Orders and Items files:</strong></p>
        <p>
          Load the files using the file drop area on the <strong>Data Import</strong> tab.
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
        <p>*needs review*</p>
        <p>
          A file whose content has been seen before is skipped, and the notice says which case it is. A
          file that an earlier import already took names the card that covers it. A file that is
          identical to <em>another file in the same drop</em> was never imported at all &mdash; the usual
          cause is an export saved twice under two names, such as an Items file holding a second copy
          of the Orders export. Re-export the missing one and drop both again.
        </p>
        <p><strong>Saved Amazon sources:</strong></p>
        <p>*needs review*</p>
        <p>
          A saved source imports Amazon exports saved into a <strong>folder to watch</strong> on the
          machine running {APP_NAME}, without the import form being opened. Sources are added on
          the <strong>File Sources</strong> tab, under <strong>Amazon</strong>, and <strong>Folder</strong> on
          a source&apos;s row sets its folder. Each one holds the Amazon account its files import into,
          whether rules are applied, and optionally a <strong>filename pattern</strong> &mdash; text the
          filename contains, which lets several sources share one folder.
        </p>
        <p>
          Several sources are the point where more than one person&apos;s order history is tracked:
          one source per Amazon account, each with its own folder or pattern, keeps the imports apart.
          The import history then lists each account&apos;s files under its own heading.
        </p>
        <p>
          A source takes files from the first one saved into its folder. A file naming a payment card
          that has no mapping is held rather than guessed at &mdash; it appears in <strong>Tasks</strong>,
          and importing it by hand once maps the card and lets the folder carry on by itself.
        </p>
      </>
    ),
  },
  {
    id: 'amazon-funding-sources',
    section: 'importing',
    title: 'Amazon import form',
    surfaces: ['Import (Amazon import form)'],
    summary: `Configures which account holds the Amazon transactions, which category the excluded Amazon payment maps to, and mapping the payment sources in the CSV file to accounts in ${APP_NAME}.`,
    body: () => (
      <>
        <p>
          These settings appear in the form that opens once Amazon CSV files have been dropped on the
          Data Import tab. Producing the files
          themselves is covered in <HelpLink to="/help/amazon-import">importing Amazon order
            detail</HelpLink>.
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
          <strong> Payment cards</strong> lists all the payment cards
          found in the import set along with the current mapping if these cards have been seen before.
          Any new cards are listed with <strong>Needs mapping</strong>. The mapping is used by {APP_NAME} to
          locate the matching <strong>AMAZON.COM</strong> charge so it can change the category to the
          specified <strong>Category for the excluded charge.</strong> Payment details live in the orders
          export, so an items file on its own lists no cards.
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
    surfaces: ['Import history (transactions ↗ pill)'],
    summary: 'After an Amazon import, the reconciliation report shows how the orders line up with the card charges in the ledger, and lists the ones that need a decision.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          After importing Amazon orders, {APP_NAME} pairs each order with the card charge that paid for it
          and excludes that charge, so the money counts once. The <strong>reconciliation report</strong>{' '}
          shows how that went. It opens from the <strong>N transactions</strong> pill on the file's card in
          the import history, which also shows <strong>N to resolve</strong> while anything needs a
          decision. The report can be moved, resized or minimized to the nav bar while transactions are
          looked at elsewhere.
        </p>

        <h4>Rows that need a decision</h4>
        <ul>
          <li>
            <strong>Duplicate detected</strong> &mdash; two or more identical charges could have paid the
            order, usually the same charge imported twice. <strong>Merge &rarr; keep one</strong> keeps the
            copy with the most detail, trashes the rest and matches the order. <strong>Discard</strong>{' '}
            beside a copy trashes just that one. <strong>Not duplicates</strong> keeps them all as separate
            purchases. Merge isn't offered when another unmatched order has the same amount.
          </li>
          <li>
            <strong>Duplicate &middot; review</strong> &mdash; the same, but the copies are more than three
            days from the order. Hovering a copy shows where it came from.
          </li>
          <li>
            <strong>Matched &middot; review</strong> &mdash; no single charge equals the order, but a set of
            charges adds up to it, usually one per shipment. <strong>Accept</strong> links them.{' '}
            <strong>Dismiss</strong> leaves the order unmatched, and the set isn't suggested again.
          </li>
          <li>
            <strong>No charge found</strong> &mdash; nothing was matched, often because the card isn't
            tracked or the order predates the card's history. Searching for the amount sometimes finds the
            charge. <strong>Link charges&hellip;</strong> picks it by hand, with a running total
            against the order. <strong>Mark reviewed</strong> is for an order with nothing to link. A
            charge that arrives later is matched then.
          </li>
          <li>
            <strong>Unaccounted &middot; duplicate</strong> &mdash; charges that look like copies of each
            other, with no order for either. Resolved like Duplicate detected.
          </li>
          <li>
            <strong>Unaccounted charge</strong> &mdash; a charge that looks like Amazon, in the import's
            date range, that no order explains. Usually a purchase the export didn't cover, which{' '}
            <strong>Mark reviewed</strong> acknowledges. <strong>Trash</strong> removes one that is a
            duplicate. <strong>Add to order&hellip;</strong> adds it to an order it was part of &mdash; see
            the part paid with card rewards, below.
          </li>
        </ul>
        <p>
          Merged and discarded copies can be restored from Settings &rarr; Trash.
        </p>

        <h4>Order categories</h4>
        <p>*needs review*</p>
        <p>
          The order is the row that counts; its paired charge is excluded. <strong>Order category</strong>{' '}
          shows each order&apos;s category and changes it in place, and setting one offers a rule for the
          orders like it, as on the Transactions page. <strong>Uncategorized orders</strong> narrows the list
          to the orders still without a category.
        </p>
        <p>
          Each order also carries the text of the charge it is paired with, shown as <strong>Card
            charge</strong> in its origin detail. A rule with <strong>Also match the original / source
              statement text</strong> on, say for <em>Kindle Svcs</em>, therefore categorizes the orders paid
          through that service, including ones whose charge is paired later. Unpairing a charge takes its
          text off the order.
        </p>
        <p>
          When the charges carry more than one name, a <strong>Charge</strong> line groups them: a service
          Amazon bills under its own name (<em>Prime Video</em>, <em>Audible</em>, <em>Kindle</em>,{' '}
          <em>Amazon Music</em>) or plain <em>Amazon</em>. Picking one with <strong>Uncategorized
            orders</strong> leaves, say, the channel orders paid through Prime Video, ready to categorize
          together.
        </p>
        <p>
          <strong>Set category&hellip;</strong> in the bar above the selected rows gives them all one
          category: the order on a row that has one, the charge itself on a row that doesn&apos;t. It sets
          the category by hand, as a bulk edit on the Transactions page does, so rules leave those rows
          alone. Split orders and rows a reimbursement claims keep their categories.
        </p>

        <h4>Matched orders</h4>
        <p>
          When a pairing is wrong, <strong>Unlink</strong> detaches the charge. The charge gets its
          category back, and the order returns to <strong>No charge found</strong>. That charge is not
          matched to the order automatically again.
        </p>
        <h4>The part paid with card rewards</h4>
        <p>*needs review*</p>
        <p>
          Paying part of an order with card rewards leaves that part out of the export&apos;s total. The
          card records it as a second Amazon charge, paid back by a credit of the same amount, so the
          charge shows as unaccounted. When the credit is on the card, the row says the charge was paid
          with rewards, and an order placed that day is named as the likely one.{' '}
          <strong>Add to order&hellip;</strong> adds the charge to that order or another: the order&apos;s
          amount grows by the charge, so it reads at what the purchase cost, the charge is excluded like
          the order&apos;s own, and the credit stays income. <strong>Remove</strong> beside the added
          charge takes it off again. A split order takes no added charge until its split is cleared.
        </p>
        <p>
          <strong>Split&hellip;</strong> on a Matched or No charge found row divides the order across
          categories without finding it in the ledger. See{' '}
          <HelpLink to="/help/transaction-splits#imported-order">splitting an imported order</HelpLink>.
          A single-item order doesn't offer it.
        </p>
        <p>
          Hovering an order or charge shows its origin detail. The <strong>↗</strong> beside an order opens
          it on Amazon.
        </p>

        <h4>How an order's charge is found</h4>
        <p>
          An order is matched to a charge of the same amount within three days, and only when exactly one
          charge qualifies. A card mapped to an account on the{' '}
          <HelpLink to="/help/amazon-funding-sources">Amazon import form</HelpLink> limits the search to that
          account. Without a mapping, the card's last four digits rule out accounts with a different card
          number.
        </p>
        <p>
          An order that names no card, such as a digital order, only matches a charge that reads as Amazon
          (<em>AMZN</em> or <em>AMAZON</em>, or the names Amazon bills its own services under: <em>Prime
            Video</em>, <em>Kindle</em> and <em>Audible</em>). One paid through PayPal lands in <strong>No charge
              found</strong> and is linked by hand.
        </p>

        <h4>Several rows at once</h4>
        <p>
          Selected rows are resolved together from the bar above the list. Each button shows how many of
          the selected rows it applies to. Undoing the import reverses everything it did.
        </p>
      </>
    ),
  },
  {
    id: 'paypal-statements',
    section: 'importing',
    title: 'PayPal statements',
    surfaces: ['Import — dropping a PayPal statement PDF or zip'],
    summary: 'PayPal’s monthly statement PDFs import like its activity CSV, each into the PayPal account it belongs to.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          PayPal&apos;s monthly statements are the easy way to get its history: one PDF per month, or a zip of
          them, dropped on the importer like any file. Each statement names its PayPal account, and the first
          time that PayPal account is seen it is given an account here &mdash; a PayPal account, or a new one.
          From then on its statements always go into that account, and that account takes no other PayPal
          account&apos;s statements.
        </p>
        <p>
          The PayPal data source&apos;s row on the <strong>File Sources</strong> tab lists each PayPal
          account and the account its statements go into. The pairing comes from the statements imported,
          not from a setting, so undoing every statement imported for a PayPal account removes it, and the
          next statement for that PayPal account asks again.
        </p>
        <p>
          Each statement becomes its own card under the PayPal data source. A transaction already in the
          ledger &mdash; from a data connection or an earlier CSV &mdash; is recognized as a duplicate and enriched
          with the statement&apos;s detail. A statement imported before is skipped, as is a month with no activity.
          A payment in another currency that PayPal paid by converting from the ledger&apos;s currency is
          imported at the converted amount, with the conversion (<em>20.00 GBP = 25.40 USD</em>) in its
          imported detail; the statement and the activity CSV both record it. A payment in another currency
          with no conversion is not imported, nor the card deposit that paid for it, so the card charge stays
          the record of that purchase. The activity CSV carries each purchase&apos;s item title, which the
          statement lacks.
        </p>
        <p>
          A statement also names the payment each refund returns, so the refund is paired with that payment
          and takes its category: categorizing the purchase moves the refund with it, and the two cancel out
          in that category. A refund in another currency converts at its own day&apos;s rate, so it may
          return a little more or less than was paid, and the difference stays in that category. This holds
          across statements, imported in any order, and for a payment imported
          from the activity CSV. A category set by hand on the refund itself ends the pairing&apos;s hold on
          it. Both transactions carry the 🔗 link marker, which names the other one and opens it. A refund sent straight back to the card or
          bank it came from leaves a withdrawal, which moves to <em>Money movement</em>. A deposit or
          withdrawal has no name of its own, so the ledger shows what kind of transaction it was in its place.
        </p>
      </>
    ),
  },
  {
    id: 'wallet-reconciliation',
    section: 'importing',
    title: 'Wallet reconciliation',
    surfaces: ['Import history (Reconciliation pill)', 'Tasks', 'Accounts (Wallet match text)'],
    summary: 'A tracked wallet — PayPal, or a payment app — is matched with the card and bank transactions on the other side of the same money, so a purchase counts once.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          An account of type <strong>PayPal</strong> or <strong>P2P</strong> is a wallet. It holds the record of
          what was bought or received &mdash; money can sit in its balance, and then the wallet transaction is the
          only record there is. What the wallet took from a card or bank, or sent back to one, also appears on
          that account under the wallet&apos;s name. Counting both would count the purchase twice, and money
          received in the wallet and cashed out would be received twice, so after every import and sync each
          wallet transaction is <strong>matched</strong> with the one on the other side, and the money counts
          once:
        </p>
        <ul>
          <li>
            A <strong>payment</strong> paid directly from a card or bank counts on the wallet side, and the card
            or bank transaction moves to <em>Money movement</em>. When the wallet transaction was already filed as
            a transfer, the card transaction is the one counted and nothing changes.
          </li>
          <li>
            A <strong>transfer</strong> &mdash; money added to the wallet from a bank or card, or cashed out to
            one &mdash; is money moving on both sides, so both transactions move to <em>Money movement</em>. A
            cash-out filed under a <HelpLink to="/help/reimbursable-expenses">Reimbursable</HelpLink> category moves
            too, since the repayment already counts in the wallet.
          </li>
        </ul>
        <p>
          A transaction on the other side is recognized by the wallet&apos;s <strong>match text</strong>, the
          words a bank or card transaction contains when it comes from that wallet. A PayPal account&apos;s is
          &ldquo;PayPal&rdquo;; any other wallet starts with its account name. Change it from the account&apos;s
          &#8943; menu on the Accounts page with <strong>Wallet match text&hellip;</strong>; empty matches
          nothing.
        </p>
        <p>
          A match is made only when it is unambiguous: one matching amount within a few days, on an account
          belonging to the same person or a shared one. A transaction a reimbursement claims is never moved, and
          is not offered. The <strong>reconciliation</strong> shows the result, for one import or sync from its
          card&apos;s <strong>Reconciliation</strong> pill (a collapsed data source or connection shows
          <strong> &#9888; N to resolve</strong> when one of its cards needs a look), or for one wallet
          account&apos;s whole history from that account&apos;s own Tasks entry. Each wallet account has its own
          entry and its own reconciliation, named for the account. A transaction on a shared account that could
          belong to either of two wallets is listed under both, and settling it in one settles it in the other:
        </p>
        <ul>
          <li><strong>Several possible matches</strong> &mdash; more than one transaction could be the other side.
            <strong> Pick&hellip;</strong> the right one, or <strong>None of these</strong>.</li>
          <li><strong>Two transactions, one match</strong> &mdash; one transaction that could equally be
            the other side of either of two wallet transactions, and only one of them can have it &mdash; usually
            because the other payment came from the wallet balance, or its own bank transaction isn&apos;t in the
            ledger. Both are listed together against it; <strong>Pick this one</strong> beside the one it belongs
            to settles the pair, and the other drops off the list with nothing to match. <strong>Neither</strong>
            when it belongs to none of them.</li>
          <li><strong>Matching transaction not found</strong> &mdash; a wallet deposit or withdrawal with nothing
            found on the other side. <strong>Link&hellip;</strong> one by hand, or <strong>Mark reviewed</strong>
            when that account isn&apos;t tracked.</li>
          <li><strong>No wallet record</strong> &mdash; a transaction naming the wallet on an account that pays
            into it, that no wallet transaction accounts for &mdash; often a gap in the wallet history. It still
            counts as it is; <strong>Mark reviewed</strong> once checked.</li>
          <li><strong>Matched</strong> &mdash; <strong>Unlink</strong> puts back whatever the match changed,
            and the same match is never made again.</li>
        </ul>
        <p>
          Undoing the import that brought either side in undoes the match. A category chosen by hand after
          matching is kept when the match is undone.
        </p>
      </>
    ),
  },
  {
    id: 'amazon-import-detail',
    section: 'importing',
    title: 'Amazon import detail report',
    surfaces: ['Import history — outcome pills (orders / items matched / no matching order / …)'],
    summary: 'The outcome pills on an Amazon file card open a report of what that import actually did: the orders it created, items matched into orders, items with no matching order yet, duplicates, and payments.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          Each Amazon file card carries outcome pills &mdash; <strong>orders</strong>, <strong>items
            matched</strong>, <strong>already enriched</strong>, <strong>no matching order</strong>,{' '}
          <strong>duplicates</strong>, <strong>payments</strong>. Clicking one opens the{' '}
          <strong>import detail report</strong> on that view. Every row shows the <strong>source file</strong> it
          came from, which is what makes file mix-ups diagnosable:
        </p>
        <ul>
          <li><strong>No matching order</strong> &mdash; the items had no order to attach to, usually because
            the items file was imported before its orders file. Their detail is <em>saved</em>, not lost:
            importing the matching orders file later attaches it automatically (no need to re-import the items
            file), and the pill flips to <strong>attached to orders</strong> once that happens. When every
            waiting item has attached, the items file&apos;s card folds into the orders card, which then lists
            both files &mdash; the same single card as importing the two together. A card with items still
            waiting stays until their orders arrive. Undoing an orders import puts the items it took back to
            waiting, ready for the next import of those orders; undoing a card that holds both files undoes
            both. Undoing the items import discards the saved detail.</li>
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
    surfaces: ['Import (file ↗ report)', 'Duplicate-detection report'],
    summary: 'The duplicate report lists the rows an import held back as duplicates or flagged as possible ones. Review rows need a decision, the other amber pills are worth a look, and the rest are settled. Hovering a pill explains it.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          {APP_NAME} builds one clean ledger out of several sources over time, and the same activity often
          arrives more than once &mdash; once from a card, again from the bank that pays it off, from an
          aggregator that has seen both, or simply because two CSV exports contain overlapping data which is a
          common situation. Duplicate detection settles the clear cases and lists the rest here.
        </p>
        <ul>
          <li>
            <strong>Review</strong> &mdash; a possible duplicate that needs a decision, usually
            a <HelpLink to="/help/cross-account-duplicates">cross-account duplicate</HelpLink>. These are
            what the <em>Possible duplicate transactions</em> task on the Tasks page counts.
          </li>
          <li>
            <strong>Matched &middot; review</strong> and <strong>Rejected &middot; review</strong> (the
            {' '}<strong>Matched nearby date</strong> and <strong>No specific match</strong> pills) &mdash;
            rows already held back that are worth a look. <strong>Import anyway</strong> brings in one that
            should not have been held back, and <strong>Mark reviewed</strong> clears the rest. They count
            toward the file card's to-review number but not toward the Tasks page.
            See <HelpLink to="/help/covered-range-review">covered-range duplicates</HelpLink>.
          </li>
          <li>Everything else is settled and needs nothing.</li>
        </ul>
        <p>
          Clicking a pill shows only those rows, and the header checkbox then selects all of them.
        </p>
        <h4>Adding detail to the existing transaction</h4>
        <p>
          A row held back as a duplicate sometimes carries detail the existing transaction lacks, such as
          a memo or a fuller name. <strong>Enrich existing</strong> adds that detail to the existing
          transaction, and <strong>Undo enrich</strong> takes it out again. <strong>Enrich existing
            transactions from this source</strong>, on the file's card or on the data source, does this for
          every row. An enriched row reads <strong>Matched</strong>, in green. The added detail shows when
          hovering the merchant name, and rules and search use it.
        </p>
        <h4>Changing a decision</h4>
        <p>
          <strong>Import anyway</strong> brings in a row that was held back. A transaction that was imported
          and removed afterwards is listed under <strong>Removed later</strong>, where{' '}
          <strong>Restore</strong> puts it back (see{' '}
          <HelpLink to="/help/removed-as-duplicates">transactions removed as duplicates after
            import</HelpLink>). Undoing the import a row was matched against checks the row again, and it
          comes in unless something else in the ledger accounts for it.
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
    summary: 'A Review row looks like a transaction already in the ledger, usually the same one arriving on a different account. Each one needs a decision.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          A <strong>cross-account match</strong> is what looks like the same transaction arriving from
          more than one source on <em>different accounts</em>. This can be real, two people paid for the
          same thing on the same date, a transit trip perhaps, or it can be a mistake where either one source
          has the account wrong or the two sources have different names for the same account and they haven't been
          paired up in {APP_NAME}.
        </p>
        <h4>Same account or different accounts</h4>
        <p>
          When rows are flagged between two accounts, the report first asks whether they are the same
          account. Either answer settles every flagged row between them.
        </p>
        <ul>
          <li>
            <strong>Same account &mdash; merge them</strong> merges the two accounts. Copies that match
            exactly are removed as duplicates. Rows that only look similar stay for review.
          </li>
          <li>
            <strong>Different accounts &mdash; keep both</strong> keeps every row, and future imports stop
            checking the pair. The pair is listed under <strong>Duplicate detection exceptions</strong> in
            Settings, where <strong>Forget</strong> undoes it.
          </li>
        </ul>
        <h4>Deciding one row</h4>
        <ul>
          <li><strong>Keep both</strong> &mdash; they are two different transactions. The pair is not
            flagged again.</li>
          <li><strong>Discard new</strong> &mdash; the new row is the duplicate.</li>
          <li><strong>Replace existing</strong> &mdash; the new row is the better record, such as the one on
            the correct account or the posted copy of a pending charge. The existing row is removed, and its
            renames, notes and tags move to the new one.</li>
        </ul>
        <p>
          When the existing copy is pending (marked <strong>P</strong>) and the new one has posted, use
          Replace existing. Discard new would keep the pending copy, which is left out of every total.
        </p>
        <p>
          With Replace existing, the category comes from the new row only when the new file is the only one
          of the two whose imported categories are used. Otherwise the existing row's category is kept.
        </p>
      </>
    ),
  },
  {
    id: 'covered-range-review',
    section: 'duplicates',
    title: 'Reviewing covered-range duplicates',
    surfaces: ['Duplicate-detection report'],
    summary: 'A row dated inside a period an earlier import already covered is held back as a duplicate, and the report names the transaction it matched. Matched nearby date and No specific match are worth a look. The rest are settled.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          Once an import has covered a period for an account, a later import of the same period is assumed
          to repeat it. Its rows are held back as duplicates, and the report shows the transaction each one
          matched. Re-importing a file, or importing an export that overlaps an earlier one, works this
          way. The <strong>Kind</strong> column names the outcome.
        </p>
        <h4>Worth a look</h4>
        <ul>
          <li>
            <strong>Matched &middot; review</strong> (the <strong>Matched nearby date</strong> pill) &mdash;
            the match is a few days away, which is common because sources post on different dates. Each row
            says how far apart the two are. <strong>Mark reviewed</strong> once the pair looks right. If they
            are different transactions, <strong>Import anyway</strong> brings the row in.
          </li>
          <li>
            <strong>Rejected &middot; review</strong> (the <strong>No specific match</strong> pill) &mdash;
            nothing matched it. This is the row to investigate: it is often missing from the other source,
            and <strong>Import anyway</strong> brings it in. Searching for the amount sometimes finds the
            match further away. Most rows here are deposits, withdrawals and other money movement with no
            payee name.
          </li>
        </ul>
        <h4>Settled</h4>
        <ul>
          <li><strong>Matched</strong> &mdash; found on the same date or a day off.</li>
          <li>
            <strong>Matched another account</strong> &mdash; the same charge is already on another account,
            usually because two sources both recorded it, such as an aggregator's export and the card's own
            download.
          </li>
          <li>
            <strong>Matched transfer</strong> &mdash; the other half of a transfer is already on another
            account, such as the card charge that funded a wallet deposit.
          </li>
        </ul>
        <p>
          <strong>Import anyway</strong> stays available on all of these, for the rare row that is a
          separate transaction.
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
    surfaces: ['Import (duplicate report)'],
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
    id: 'not-imported-rows',
    section: 'importing',
    title: 'Rows a file left behind',
    surfaces: ['File ledger (↗)'],
    summary: 'A file’s report has a Not imported view listing every row the import did not take, and the reason for each.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          A file often holds more than the ledger takes from it. The report opened by the{' '}
          <strong>↗</strong> beside a file name has a <strong>Not imported</strong> view listing
          each row that was left out, with the reason beside it: a date or amount that could not be
          read, a currency the ledger does not hold, a zero amount, an account set to <em>Skip</em>, or
          the trailing text at the end of an export. The list sorts and searches like the imported one,
          and the pills above it narrow it to a single reason. The <strong>rejected</strong> count on
          the file&apos;s card opens the same view.
        </p>
        <p>
          Rows held as possible duplicates are counted there rather than listed, because they are
          reviewed &mdash; and can be imported anyway &mdash; on the{' '}
          <HelpLink to="/help/duplicate-report">duplicate report</HelpLink>.
        </p>
        <p>
          A few hundred rows are kept per file. A file mapped to the wrong columns can have every row
          refused, so the view states the full count whenever it is showing part of one. A reason with
          none of its rows kept still shows its count, but its pill cannot be chosen.
        </p>
      </>
    ),
  },
  {
    id: 'removed-as-duplicates',
    section: 'duplicates',
    title: 'Transactions removed as duplicates after import',
    surfaces: ['File ledger (↗)', 'Duplicate-detection report (Removed later)'],
    summary: 'Transactions that were imported and then removed because they turned out to be duplicates. They are kept on the duplicate report and can be restored.',
    body: () => (
      <>
        <p>
          The import process automatically filters out transactions it is confident are duplicates. When
          it is not clear, the transaction is imported and also added to
          the <HelpLink to="/help/duplicate-report">duplicate report</HelpLink> to be examined. If it turns
          out to be a duplicate, one of the two copies is removed from the ledger.
        </p>
        <h4>What removes a transaction</h4>
        <ul>
          <li>
            <strong>Discard new</strong> on a suspected duplicate. The newly imported transaction is
            removed and the one already in the ledger stays.
          </li>
          <li>
            <strong>Replace existing</strong> on a suspected duplicate. The newly imported transaction is
            the better record, so it stays and the one already in the ledger is removed.
          </li>
          <li>
            <strong>Merging two accounts.</strong> Two sources sometimes use different names for the same
            account, so each one's transactions land on a separate account.{' '}
            <HelpLink to="/help/merging-accounts">Merging</HelpLink> the accounts puts both sets on one
            account, and a transaction both sources brought in is then there twice. One copy of each is
            removed.
          </li>
          <li>
            <strong>A card charge that is in the ledger twice for one Amazon order.</strong>{' '}
            The <HelpLink to="/help/amazon-reconciliation">Amazon reconciliation report</HelpLink> lists
            these as <strong>Duplicate detected</strong>, and the extra copy is removed from there.
          </li>
        </ul>
        <h4>Finding a removed transaction</h4>
        <p>
          A removed transaction is not deleted. It stays on the duplicate report of the file that imported
          it, under <strong>Removed later</strong>, beside the transaction that was kept in its place.
        </p>
        <p>
          After <strong>Replace existing</strong>, the removed transaction is one that an earlier file
          imported, so it is on that earlier file's report and not on the report where the choice was made.
        </p>
        <p>
          A file that has had transactions removed shows <strong>Removed as duplicates</strong> with a
          count above its transaction list (the <strong>↗</strong> beside the file name). The link there
          opens the duplicate report on only those transactions.
        </p>
        <h4>Putting one back</h4>
        <p>
          <strong>Restore</strong> on the row returns the transaction to the ledger. For merged accounts,
          detaching the account returns all of them at once.
        </p>
      </>
    ),
  },
  {
    id: 'page-tasks',
    section: 'tasks',
    title: 'Tasks',
    surfaces: ['Tasks'],
    summary: 'Various alerts about things which may need attention.',
    body: () => (
      <>
        <p>
          Tasks is where notifications are posted when there is something that needs attention.
        </p>
        <p>
          Some of the things which generate notifications are:
        </p>
        <ul>
          <li> transactions which need categorization</li>
          <li>a newly detected recurring series</li>
          <li>a change in the amount for a suspected member of an existing recurring series</li>
          <li>recurring detection that has not caught up with changed transactions</li>
          <li>a problem fetching transactions from a data connection</li>
          <li>a transaction matching a rule that raises an <HelpLink to="/help/page-rules#rule-alerts">alert</HelpLink></li>
          <li>an error recorded in the log file</li>
          <li>a change since the last backup that makes earlier backups less useful, such as a new vault
            passphrase, a replaced vault key or replaced data provider credentials</li>
        </ul>
        <p>Anything which might require attention will appear here.</p>
        <p>
          <strong>Dismiss</strong> hides the notification until
          something changes. For instance, if the note about uncategorized
          transactions is dismissed, the task reappears when new ones are added to the list.
        </p>
        <p>*needs review*</p>
        <p>
          A rule alert can also be muted. <strong>Mute</strong> moves it to the dismissed list, where its
          count keeps going up without it coming back, until it is dismissed or unmuted there.
        </p>
      </>
    ),
  },
  {
    id: 'page-settings',
    section: 'settings',
    title: 'Settings',
    surfaces: ['Settings'],
    summary: 'User Preferences, Backup/Restore, CSV Export, and various maintenance functions.',
    body: () => (
      <>
        <p>Settings is a collection of both controls that affect {APP_NAME}'s behavior
          and various utility type functions.
        </p>
        <HelpHeading anchor="personal">Personal</HelpHeading>
        <ul>
          <li>
            <strong>Appearance</strong> adjusts the display theme, the display size, and how
            dates and numbers are displayed and interpreted as input.
            Display scaling and the theme are stored for different devices based on screen size.
            This means that a tablet can have different settings for portrait and landscape modes.
            The settings are per screen size+input device (touch v mouse), so two devices with the same screen size
            and same pointer device will share the same settings. Screen layout (eg. column sizes and order) for
            the various tables is also stored per screen size+input device. There is a right-click menu
            on the user profile at the bottom of the navigation pane that also allows the scaling
            factor to be changed. Administrators can also choose whether the navigation pane shows where
            the database files are.
          </li>
          <li>
            <strong>Security</strong> (only visible when sign-in protection is enabled) supports
            changing the password, adding passkeys and enabling 2FA as part of password access.
            See <HelpLink to="/help/account-security">account security</HelpLink>.
          </li>
          <li>
            <strong>Administration</strong> (only visible when sign-in protection is off) shows or
            hides the features that manage the installation: the Server settings, Backup / Restore,
            provider setup and their reminders on the Tasks page. Hidden features still work; this is a
            display choice for each profile, not protection. When sign-in protection is turned on, only
            administrators see them, whatever was chosen here.
          </li>
        </ul>
        <HelpHeading anchor="data">Data</HelpHeading>
        <ul>
          <li>
            <strong>Backup / Restore</strong> makes and restores system backups. Generates
            and tracks backup encryption keys. Administrators
            only. See <HelpLink to="/help/backup-restore">Backup / Restore</HelpLink>.
          </li>
          <li>
            <strong>CSV export</strong> generates a portable CSV file containing the selected
            transaction information.
            See <HelpLink to="/help/csv-export">exporting transactions to CSV</HelpLink>.
          </li>
          <li>
            <strong>Trash</strong> holds deleted items to serve as an undo
            mechanism. Items can be purged from the trash which is not reversible. A transaction a data
            connection stopped reporting is moved here too, marked <em>Pending, dropped by the
            bank</em> or <em>Withdrawn by the bank</em>.
          </li>
          <li>
            <strong>Duplicate detection exceptions</strong> holds two lists.{' '}
            <ul>
              <li>

                <strong>Dismissed duplicate pairs</strong> lists the pairs of transactions that have
                been marked as not duplicates. These are stored so a subsequent pass does not
                suggest them as duplicates again. Mistakes can be corrected by reopening a dismissed
                pair and then returning to the duplicate detection report to resolve it.{' '}
              </li>
              <li>
                <strong>Distinct account pairs</strong> lists the pairs of accounts that have been
                identified as distinct because a cross-account duplicate was surfaced and the action
                was to accept both transactions. Cross-account duplicates exist because different sources
                may identify the same account differently so what appears to be a cross-account duplicate
                may in fact be the same transaction in the same account with two different names. This
                table is about tracking the pairs which are not the same. Mistakes can be removed with
                the <strong>Forget</strong> button.
              </li>
            </ul>
          </li>
          <li>
            <strong>Currency</strong> defines the meaning of the values in the
            ledger. <HelpLink to="/help/single-currency">single-currency support</HelpLink> has details.
          </li>
        </ul>
        <HelpHeading anchor="server">Server</HelpHeading>
        <p>What affects the whole installation. Administrators only.</p>
        <ul>
          <li>
            <strong>User management</strong> adds and removes the users who can sign in, sets
            whether each is an administrator, and resets a password. It is listed only while sign-in
            protection is on.
          </li>
          <li>
            <strong>Sign-in protection</strong> manages sign-in protection sets the
            password requirements. See <HelpLink to="/help/account-security">account security</HelpLink>.
          </li>
          <li>
            <strong>Security checklist</strong> reports on this installation's compliance with
            the recommended best practices.
            See <HelpLink to="/help/security-checklist">security checklist</HelpLink>.
          </li>
          <li>
            <strong>Server certificate</strong> when a HTTPS proxy is in use to display the
            certificate each computer needs to install so that its browser will trust the server.
            Instructions are available for Windows, Mac, Linux and a tablet. The
            certificate's fingerprint is displayed so it can be verified.
          </li>
          <li>
            <strong>Startup configuration</strong> lists the current value and source of the various settings.
            Most of the settings here come from the optional <code>.env</code> file.{' '}
            <HelpLink to="/help/configuration">Configuration settings</HelpLink> has details.
          </li>
          <li>
            <strong>Error log</strong> lists the errors recorded in the "console log" file.
          </li>
          <li>
            <strong>Database Maintenance</strong> reports on database health and supports
            freeing various kinds of unneeded space.
            See <HelpLink to="/help/database-maintenance">database maintenance</HelpLink>.
          </li>
        </ul>
        <p>
          <strong>Copy details</strong> copies various version and configuration details
          useful in a problem report to the
          clipboard. Identifying system details and financial data are not included.
        </p>
      </>
    ),
  },
  {
    id: 'running-a-server',
    section: 'administration',
    title: `Running ${APP_NAME} as a server`,
    surfaces: ['Set up HTTPS (Tasks)', 'Security checklist (Settings)'],
    summary: `One computer hosts ${APP_NAME} for the other computers in the household.`,
    body: () => (
      <>
        <p>
          A downloaded copy of {APP_NAME} normally serves only the computer it runs on. Started in{' '}
          <strong>server mode</strong>, {APP_NAME} stays running in the background
          and responds to <code>luma.local</code> (by default) on the local network.        </p>
        <p>
          All users see the same data. Sign-in protection can be enabled to limit access.
          See <HelpLink to="/help/account-security">account security</HelpLink> for details.
        </p>

        <HelpHeading anchor="with-https">With HTTPS</HelpHeading>
        <p>
          Without HTTPS other computers connected to the server cannot use passkeys and cannot open
          the vault. The issue with passkeys is part of the passkey implementation. The vault is {APP_NAME}'s
          rule: the vault passphrase protects the data provider credentials, so it is not accepted over
          an unencrypted connection. With the vault closed, data connections cannot be created or synced.
          Passkeys and data connections can be used from a browser on the server accessing the
          server via <code>localhost</code>.
        </p>
        <p>
          HTTPS access is provided by Caddy, a small program which handles HTTPS connections and passes
          the requests to {APP_NAME} over HTTP. Best practice is to accept the default configuration
          where  {APP_NAME} only responds to HTTP requests from the local machine, from localhost. A
          browser running on the server can access {APP_NAME} via localhost but all other machines need
          to access luma.local via https.
        </p>
        <HelpHeading anchor="on-linux">On a Linux server</HelpHeading>
        <p>
          These are the steps to configure Caddy as the proxy and {APP_NAME} to start at system boot. Run
          them from the folder with the download as the user the server should run as.
        </p>
        <ol>
          <li>
            To adjust any of the default settings, including the network name {APP_NAME} advertises,
            use <code>env-example.txt</code> to create a file
            named <code>.env</code> beside the program containing the changes.
          </li>
          <li>Install Caddy from the Linux distribution's packages.</li>
          <li>
            Use {APP_NAME} to generate the Caddy configuration file and activate it:
            <pre><code>{'./luma --caddyfile | sudo tee /etc/caddy/Caddyfile\nsudo systemctl reload caddy'}</code></pre>
          </li>
          <li>
            Install {APP_NAME} as a service, so it starts when the computer boots:
            <pre><code>{'./luma --systemd-unit | sudo tee /etc/systemd/system/luma.service\nsudo systemctl daemon-reload\nsudo systemctl enable --now luma'}</code></pre>
          </li>
          <li>
            Open <code>https://luma.local</code> from another computer. <code>journalctl -u luma</code>{' '}
            on the server shows the address if a different name was chosen.
          </li>
        </ol>
        <p>
          Allow TCP port 443 and UDP port 5353 through the firewall.
        </p>

        <HelpHeading anchor="on-windows">On a Windows server</HelpHeading>
        <p>
          On Windows {APP_NAME} configures and runs Caddy itself, and is set to start when its user
          signs in. From the folder containing the contents of the download:
        </p>
        <ol>
          <li>
            Create the <code>.env</code> file as in the first step above.
          </li>
          <li>
            Download Caddy for Windows and put <code>caddy.exe</code> in the same folder
            as <code>luma.exe</code>.
          </li>
          <li>
            In a command prompt in that folder, set {APP_NAME} to start when the user signs in:
            <pre><code>{'luma --start-at-sign-in'}</code></pre>
            From the next sign-in on, {APP_NAME} starts as a server with no window. An icon in the
            notification area shows the address, opens {APP_NAME}, and stops and starts it.
          </li>
          <li>
            The first time {APP_NAME} runs, Windows Firewall asks which networks may reach Caddy and
            which may reach {APP_NAME}. Select <strong>Private networks only</strong> to avoid accepting
            connections on a public wifi. If {APP_NAME} is not reachable on the home network, Windows
            may be treating the home network as public.
            Search for "Allow an app through Windows Firewall" to check the firewall settings and "Firewall & network protection"
            for the public/private network setting.
          </li>
        </ol>
        <p>
          To start the server without signing out and back in, use
          <pre><code>luma --server --tray</code></pre>
          Disable starting at sign-in with
          <pre><code>luma --no-start-at-sign-in</code></pre>

          If {APP_NAME} is moved to a different folder, the start-at-sign-in command needs to be run
          again from the new location to update the Windows registry.
        </p>
        <p>
          The server runs while that user is signed in. To have the server start with the computer instead, with nobody signed in, use a Windows
          scheduled task instead of starting at sign-in:
        </p>
        <ol>
          <li>
            In <strong>Task Scheduler</strong>, choose <strong>Create Task</strong> and
            select <strong>Run whether user is logged on or not</strong>.
          </li>
          <li>
            Add a trigger of <strong>At startup</strong>, and an action that starts{' '}
            <code>luma.exe --server</code> from its folder.
          </li>
          <li>
            Clear <strong>Stop the task if it runs longer than 3 days</strong> and, on a
            laptop, <strong>Start the task only if the computer is on AC power</strong>.
          </li>
        </ol>
        <p>
          A server started this way has no icon in the notification area. Its address is on the
          start line of <code>luma.log</code>, beside the data.
        </p>

        <HelpHeading anchor="on-mac">On a Mac</HelpHeading>
        <p>**needs review** verify on a mac</p>
        <p>
          A Mac can be the server as well, with the same <code>.env</code> file and the same Caddy
          configuration, which <code>luma --caddyfile</code> prints. An application started from
          Finder takes no command line, so server mode is set with <code>SERVER_MODE=true</code> in{' '}
          <code>.env</code>. Installing Caddy and starting both at boot are set up with that system's own
          tools.
        </p>

        <HelpHeading anchor="each-device">On each computer that connects</HelpHeading>
        <p>
          The first visit shows a browser warning, because the proxy issues its own certificate and no
          computer trusts it yet. Continue past the warning once, choose{' '}
          <strong>Browser warning about this server? Install its certificate</strong> on the sign-in
          screen, and follow the steps shown for that kind of computer. After the browser is closed and reopened
          the warning is gone for good. With sign-in protection off there is no sign-in screen, and the
          same download and steps are under <strong>Settings &rarr; Server certificate</strong>.
        </p>
        <p>
          To be sure a computer received the server's own certificate, compare the fingerprint that
          computer shows for it against the one printed on the server
          by <code>./luma --certificate-fingerprint</code>. <strong>Server certificate</strong> also
          has a box that takes a fingerprint and reports whether it matches.
        </p>

        <HelpHeading anchor="without-https">Without HTTPS</HelpHeading>
        <p>
          To configure a server so it can be reached from the network via HTTP:
        </p><p>
          Skip the Caddy steps and define FRONTEND_HOST in the <code>.env</code> file:
          <pre><code>FRONTEND_HOST=0.0.0.0</code></pre>
          Use <code>http://luma.local:8010</code> to reach {APP_NAME}.
        </p>
        <p>The following are the consequences of using HTTP to reach a server:
        </p>
        <ul>
          <li>
            Everything crosses the network unencrypted, sign-in passwords included.
          </li>
          <li>Passkeys are unavailable.</li>
          <li>
            The vault opens only from a browser on the server itself, so that is where a data source is
            connected and synced. The vault passphrase protects the data provider credentials in the
            database and in every backup, and is not accepted over an unencrypted connection.
            Everything else works from any computer.
          </li>
        </ul>
        <p>
          <strong>Settings &rarr; Security checklist</strong> shows whether other devices can reach
          the server without HTTPS.
        </p>

        <HelpHeading anchor="updating">Updating the server</HelpHeading>
        <ul>
          <li>
            <strong>Linux:</strong> stop the service, unzip and untar the download over the current installation, and
            re-start it:
            <pre><code>{'sudo systemctl stop luma\nunzip luma-<version>-linux-<arch>.zip\ntar -xzf luma-<version>-linux-<arch>.tar.gz\nsudo systemctl start luma'}</code></pre>
          </li>
          <li>
            <strong>Windows:</strong> choose <strong>Exit</strong> on the system tray icon, unzip the new
            download into the same folder, and start {APP_NAME} again. A server started by a scheduled
            task is stopped and started from Task Scheduler instead.
          </li>
          <li>
            <strong>Mac:</strong> stop the server, drag the new application onto Applications, and start it again.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'security-checklist',
    section: 'administration',
    title: 'Security checklist',
    surfaces: ['Security checklist (Settings)'],
    summary: `Compares this installation with the recommended security practices.`,
    body: () => (
      <>
        <p>
          Each line is a recommended practice, whether this installation meets it, and a link to where it
          is changed. Practices that don't apply to the configuration are omitted (an instance served over
          localhost does not require HTTPS). Nothing is enforced; deciding to ignore a practice is allowed.
        </p>
        <p>
          Choosing to run a server configuration without HTTPS introduces two limits
          because the network traffic is not encrypted. Passkeys do not function without
          https if they are from a host other than localhost, and {APP_NAME} refuses to
          open the vault because its passphrase would be exposed on the network. Data sources are
          then connected and synced from a browser on the server.

        </p>
        <p>
          An issue flagged with a red <strong>Not met</strong> is more urgent than an amber one. It means a protection that is set
          up can be bypassed. For example, when HTTPS is configured, if {APP_NAME} is
          reachable without going through the HTTPS proxy then some traffic will be encrypted
          but some will not. This may be intentional to allow for passkeys and data connections
          while still allowing for non-HTTPS traffic.   <strong>Unknown</strong> means the practice cannot be judged yet. <strong>Info</strong> reports a choice
          without judging it: whether other devices have to sign in depends on who is on the network.

        </p>
      </>
    ),
  },
  {
    id: 'configuration',
    section: 'administration',
    title: 'Configuration settings',
    surfaces: ['Startup configuration (Settings)'],
    summary: `Every setting has a working default, so nothing needs configuring to get started. A .env file overrides the handful of values that have to be known before the app starts, such as the port and where the database files live.`,
    body: () => (
      <>
        <p>
          Nothing has to be configured before {APP_NAME} runs. Every setting falls back to a working
          default, so a plain installation needs <strong>no configuration file at all</strong>.
        </p>
        <p>
          Two settings worth knowing about:
        </p>
        <ul>
          <li>
            <strong>Data directory</strong> is where both database
            files live, along with the <code>documents</code> folder holding attachments and
            the <code>luma.log</code> error log &mdash; change to move an installation's data, possibly to run a
            second installation on the same machine. The two database rows beneath it are shown for
            confirmation and follow it automatically.
          </li>
          <li>
            <strong>Port</strong> is the port the browser connects to, 8010 unless changed. A
            downloaded copy of {APP_NAME} uses this one port for everything, and if another program already
            holds it, starts on a free port instead and reports the address it chose.
          </li>
        </ul>
        <p>
          Most users do not need to touch the settings under <strong>Advanced</strong>. One of them,
          {' '}<strong>Backend port</strong>, only matters when {APP_NAME} runs from source code,
          where the interface is served separately and passes requests on to the backend on that
          port. A downloaded copy does not use it.
        </p>
        <p>*needs review*</p>
        <p>
          <strong>Application name</strong> tells two installations apart: it labels the passkeys saved
          for each, and the navigation pane shows it under {APP_NAME} when it is different. Starting it
          with <code>&lt;red&gt;</code>, <code>&lt;green&gt;</code>, <code>&lt;yellow&gt;</code> or{' '}
          <code>&lt;blue&gt;</code> shows the name in that colour, for example{' '}
          <code>APP_NAME=&lt;red&gt;Luma Demo</code>; a colour with the name unchanged colours {APP_NAME}
          itself. Anything else in angle brackets stops {APP_NAME} from starting, with a message saying why.
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

        <HelpHeading anchor="env-file">The .env file</HelpHeading>
        <p>
          An override is a line in a plain text file named <code>.env</code>, one setting per line in the
          form <code>NAME=value</code> &mdash; for example <code>FRONTEND_PORT=8020</code>. Each setting on the
          Startup configuration screen shows the name to use. Changes take effect the next time {APP_NAME} starts.
        </p>
        <p>
          The screen shows the exact path the file is read from, whether or not the file exists yet. Where
          that is depends on how {APP_NAME} was installed: beside the program for a portable download, in
          <code> ~/Library/Application Support/Luma</code> for the macOS app, and at the top of the
          folder for a copy run from source code.
        </p>
        <p>
          <code>env_example.txt</code> lists every setting with an explanation, marked with the ways of running
          {' '}{APP_NAME} it applies to. It comes with every download (beside the program, or in the macOS disk
          image) and sits at the top of the source code folder. Copying it to <code>.env</code> and removing
          the <code>#</code> in front of a setting turns that setting on.
        </p>
      </>
    ),
  },
  {
    id: 'database-maintenance',
    section: 'administration',
    title: 'Database maintenance',
    surfaces: ['Database Maintenance (Settings)'],
    summary: 'The database files can be checked for damage, and space they no longer need given back, from Settings.',
    body: () => (
      <>
        <p>
          {APP_NAME} stores data in two database files: data.db is the default location for the ledger and
          control.db holds users, settings and security information. Documents are stored in the documents
          directory which lives next to the databases. <strong>Startup configuration</strong> on the
          Settings page lists these locations and indicates whether the names have been overridden.
        </p>
        <HelpHeading anchor="pairing">Keeping the two files together</HelpHeading>
        <p>*needs review*</p>
        <p>
          The two database files belong to each other, so they are always moved or copied as a pair. If
          {' '}{APP_NAME} is started with a ledger from a different installation, or the settings point at a
          ledger that is not there, it shows a page explaining what is wrong instead of opening. Correcting
          the setting is usually the fix. A ledger brought over from another computer is paired with this
          installation from the command line, as described in the{' '}
          <a href="https://github.com/jeff162/luma#the-databases-do-not-belong-together" target="_blank" rel="noreferrer">README's
            <em> The databases do not belong together</em> section</a>.
        </p>
        <HelpHeading anchor="checking">Checking the databases</HelpHeading>
        <p>
          <strong>Database Integrity</strong> runs an internal database integrity check to ensure
          that the databases are error free. It also verifies that the documents in the document directory
          are readable. The same checks run as part of a backup or restore.
        </p>
        <HelpHeading anchor="space">Space used</HelpHeading>
        <p>
          Free space in the database is created when transactions and other items are deleted. This
          space gets reused before the database grows or it can be manually freed
          with <strong>Compact now</strong>. Large deletions trigger a compaction automatically.
        </p>
        <HelpHeading anchor="import-storage">Excess import storage</HelpHeading>
        <p>
          Imports retain rows which were not added to the ledger so a decision regarding duplicates can be
          revisited and a skipped or rejected row imported later. Depending on the pattern of imports this
          may be a significant amount of space and it is carried in the
          backup. <strong>Show import space&hellip;</strong> lists what each import holds, and <strong>Clear
            detail</strong> there returns the space when it is no longer needed for the selected import files.
        </p>
      </>
    ),
  },
  {
    id: 'single-currency',
    section: 'general-concepts',
    title: 'Single-currency support',
    surfaces: ['Settings \u2014 Currency'],
    summary: 'A ledger holds one currency at a time, chosen on the Settings page. Amounts are stored as plain numbers, so changing the setting relabels every figure rather than converting it, and an account a data provider reports in another currency is skipped rather than imported.',
    body: () => (
      <>
        <p>
          Every amount in {APP_NAME} is stored as a plain number, with no currency recorded beside it.
          The <strong>Currency</strong> setting says what all of those numbers mean, and it is one choice
          for the whole ledger rather than a property of an account or a transaction.
        </p>
        <p>
          Changing it <em>relabels</em> every existing amount; nothing is converted or rewritten. That
          makes a wrong choice cheap to correct and equally cheap to reverse, which is why the change asks
          for confirmation rather than being refused.
        </p>
        <p>
          The consequence worth knowing about is at the edge, where data arrives. An account that a
          data provider reports as held in another currency is <strong>skipped</strong> &mdash; its
          transactions are not imported, and the account-mapping screen says so rather than letting the
          account sync cleanly and sit permanently empty. Where one source carries several currencies, the
          transactions in a foreign one are dropped the same way. The exception is a PayPal payment that
          PayPal converted the ledger&apos;s currency to pay: it is imported at the converted amount (see{' '}
          <HelpLink to="/help/paypal-statements">PayPal statements</HelpLink>). A CSV file with a mapped
          currency column has its rows in another currency refused; without one it is taken at face value,
          so a file holding another currency imports figures that do not mean what the rest of the ledger
          means.
        </p>
      </>
    ),
  },
  {
    id: 'backup-restore',
    section: 'general-concepts',
    title: 'Backup / Restore',
    surfaces: ['Backup / Restore (Settings)'],
    summary: 'Creating and restoring backups.',
    body: () => (
      <>
        <p>
          Backups are made and restored by an administrator, using <strong>Backup / Restore</strong> on
          the <HelpLink to="/help/page-settings#data">Settings</HelpLink> page. A backup holds everything,
          in three parts which a restore can put back separately:
        </p>
        <ul>
          <li>
            <strong>Ledger</strong> &mdash; accounts, owners, transactions, categories, tags, rules,
            attached documents and preferences. This is the data.db file, stored in{' '}
            <strong>plain text</strong>, and the documents directory next to it. For data connections,
            everything except the secret credential.
          </li>
          <li>
            <strong>Users &amp; security</strong> &mdash; the users, the sign-in settings, password hashes,
            two-factor secrets, and the backup keys. This is the control.db file.
          </li>
          <li>
            <strong>Data provider credentials</strong> &mdash; the stored provider and account connection
            credentials, encrypted as they are in
            the <HelpLink to="/help/credential-vault">vault</HelpLink>. The vault is spread across both
            files and opens with its users' unlock methods (passphrases, recovery codes and passkeys),
            which is why the credentials restore together with Users &amp; security.
          </li>
        </ul>
        <p>
          Protection for the transaction data comes from the computer's security (disk encryption,
          OS login, who can physically reach the machine, who has access to the network).
          A sign-in password is available to restrict <em>network</em> access to {APP_NAME}. An
          unencrypted backup is as exposed as the database files;{' '}
          <HelpLink to="/help/copied-database">if the database or a backup is copied</HelpLink> has
          the steps.
        </p>
        <HelpHeading anchor="backups">Backups</HelpHeading>
        <p>
          The encrypted contents are only as hard to break into as the weakest unlock method. Recovery codes and
          passkeys are known to be strong, so they are always included. A backup that isn't encrypted omits any
          vault passphrase that hasn't been validated by the strength rules (has not been used since
          the rule changed as part of an upgrade). If that would leave no way to open the
          vault, the credentials are
          omitted. <strong>Generate backup</strong> complains in this situation and
          requests confirmation. If the passphrase
          for the user running the backup is not known to be strong,
          the warning offers to <strong>Validate</strong>{' '}
          or <strong>Change</strong> the passphrase.
        </p>
        <p>
          A backup can be encrypted which
          protects the entire contents of the backup. Since this is not sensitive to attack
          by guessing passphrases, an encrypted backup carries every vault passphrase.
          The private key needs to be kept somewhere safe, apart from the backup.
        </p>
        <HelpHeading anchor="restoring">Restoring a backup</HelpHeading>
        <p>
          A restore operation starts by erasing the section being restored so following a restore all
          that remains is what was in the backup. Data provider connections start syncing from the last
          syncpoint recorded in the backup. Passkeys added under a host name this system is not opened at
          are left out (see <HelpLink to="/help/passkey-host-names">passkeys and host names</HelpLink>).
        </p>
        <HelpHeading anchor="partial-restore">Restoring part of a backup</HelpHeading>
        <p>
          <strong>Ledger</strong> only replaces the accounts, transactions, categories, rules, documents
          and preferences. Users, sign-in settings and the vault stay as they are. This is the choice when
          moving a ledger onto an installation that already has its own users. For existing connections
          not in the backup use <strong>Refresh accounts</strong> on the connection menu to restore the
          accounts and re-fetch the transaction history. The old ledger may have contained transactions no
          longer available in the history from the data provider. These will be lost. To preserve these,
          consider a CSV export of the transactions before performing the restore.
        </p>
        <p>
          <strong>Users &amp; security</strong> but not <strong>Data provider credentials</strong> retains
          the existing vault, however only existing users who are in the backup will be able to open it
          after the restore. If none of the existing users are in the backup, the vault is reset and the
          connections need to be re-established.
        </p>
        <HelpHeading anchor="older-credentials">Credentials in an older backup</HelpHeading>
        <p>*needs review*</p>
        <p>
          After <strong>Replace vault key</strong> <em>to end someone's access</em>, or a <strong>vault
            reset</strong> <em>for a compromised passphrase</em>, earlier backups hold credentials under a
          key that may be known to someone who should not have it. Restoring one asks first: restore
          everything but those credentials, or type <strong>RESTORE ANYWAY</strong> to restore them too.
          Restoring them puts that key back in use here; <strong>Replace vault key</strong> afterwards ends
          that, and a passphrase in the backup that may also be known needs changing as well. The record of
          retired keys belongs to this system; the system a backup came from may still be using the key.
        </p>
        <p>
          After <strong>Respond to an exposure</strong>, earlier backups hold the account connection
          credentials the providers replaced, which no longer work; those account connections need
          re-establishing after restoring one.
        </p>
        <p>
          A vault reset <em>for a forgotten passphrase</em> is different. Nothing was exposed, so
          restoring <strong>Users &amp; security</strong> restores the vault and the unlock methods in use
          when the backup was made. The restore will identify any connections which had been updated since
          the backup as they may need attention.
        </p>

      </>
    ),
  },
  {
    id: 'copied-database',
    section: 'general-concepts',
    title: 'What to do if the database or an unencrypted backup is stolen',
    surfaces: ['Vault settings (Respond to an exposure)'],
    summary: 'While the transactions in a copied database or unencrypted backup are exposed, the provider credentials are encrypted, but should be replaced.',
    body: () => (
      <>
        <p>
          A lost encrypted backup is not a concern as long as the private encryption
          key is not also stolen. Data provider credentials are always encrypted on disk, and vault
          passphrases must be strong enough to resist attempts to guess them. Even so, best practice is
          to replace the provider connection credentials and change the vault passphrase. A passphrase
          guessed later is then of no use.
        </p>

        <HelpHeading anchor="steps">The steps, in order</HelpHeading>
        <ol>
          <li>
            Open <HelpLink to="/help/vault-settings">Vault settings</HelpLink> from
            the Connections tab, and under <strong>Respond to an exposure</strong>{' '}
            choose <strong>Replace connection credentials&hellip;</strong>.
          </li>
          <li>
            For a provider with an app secret, such as Plaid: create a new secret on its website, enter
            it in the <strong>Configure</strong> menu, then delete the old one there. Every request needs
            the secret, so the copy can no longer reach the provider, and no account connection needs
            reconnecting. For other providers, such as SimpleFIN, revoke the existing credential on the
            provider&apos;s website, issue a new one, and connect again with it.
          </li>
          <li>
            Change the vault passphrase, under <strong>Unlock methods</strong>.
          </li>
          <li>
            Choose <strong>Replace vault key&hellip;</strong>, answering <em>after an exposure</em>.
          </li>
          <li>
            Make a new <HelpLink to="/help/backup-restore#backups">backup</HelpLink>.
          </li>
        </ol>
      </>
    ),
  },
  {
    id: 'passkey-host-names',
    section: 'general-concepts',
    title: 'Passkeys and host names',
    surfaces: ['Backup / Restore (passkeys not restored)', 'Vault settings', 'Settings (Sign-in passkeys)'],
    summary: 'A passkey works only at the host name it was added under. A restore leaves out passkeys added under a name this system is not opened at.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          A passkey belongs to the host name in the address bar when it was added, and the browser offers
          it only at that name. A passkey added at <code>server.local</code> does not work
          at <code>localhost</code>, even in the same browser with the same data. A system opened under two
          names needs a passkey added at each name it is used from. A passkey added under another name is
          not offered here, and its entry in Vault settings or the sign-in passkeys says where it works.
        </p>
        <HelpHeading anchor="restore">Restoring on another system</HelpHeading>
        <p>
          A backup records the name each passkey was added under, for unlocking the vault and for signing
          in. A name counts as this system&apos;s once a page of it has been opened there. A restore leaves
          out the passkeys added under any other name, since they could never work here, and lists them
          before anything changes. The password still signs in. Someone whose only way into the vault was
          one of them has no access afterwards, until they set a passphrase or add a passkey and someone
          who can open the vault approves it.
        </p>
        <p>
          Keeping those passkeys means opening this system at the name they were added under and restoring
          the backup again. That can take more than a setting: the name has to reach this machine (on a
          local network only one machine answers to a <code>.local</code> name), and any name
          but <code>localhost</code> needs HTTPS, usually from a reverse proxy.
        </p>
        <HelpHeading anchor="copied-database">A copied database</HelpHeading>
        <p>
          A database copied from another system brings that system&apos;s passkeys, each marked with the
          name it works at. <strong>Remove</strong> deletes one this system is never opened at.
        </p>
      </>
    ),
  },
  {
    id: 'account-security',
    section: 'general-concepts',
    title: 'Account security: password, passkeys and two-factor',
    surfaces: ['Sign-in protection (Settings)', 'Security (Settings)'],
    summary: `Sign-in protection is available to keep people with access to the network from using the app. All of the users share the same data.`,
    body: () => (
      <>
        <p>
          Sign-in protection exists to keep <strong>non-users out</strong>. This could be other people
          who have access to the machine running {APP_NAME}, or people who have access to the network
          when {APP_NAME} is running as a server. Sign-in protection also limits access to the
          set of administrative functions (users can be designated an administrator or not).
          All {APP_NAME} users see and edit the same data; there is no concept of some data
          being hidden from some users. See{' '}
          <HelpLink to="/help/backup-restore">Backup / Restore</HelpLink> for
          information on what needs to be protected on disk if that is of interest.
        </p>
        <p>
          Sign-in protection is managed in the <HelpLink to="/help/page-settings#server">Settings</HelpLink> page.
          Enabling sign-in protection involves selecting a required password policy and creating a password
          for the current user who becomes an administrator. Other users will be prompted to create a password
          when they next connect. A password can be entered for them by an administrator but they will
          be forced to change the password when they connect. Assigning a password prevents a different person
          from claiming the account before the target user logs in.
        </p>
        <p>
          <strong>Password policy</strong> sets how strong account passwords must be. It applies to
          all users, and it can be tightened or relaxed at any time. This does not affect existing passwords,
          only newly created passwords.
        </p>
        <p>
          <strong>Strong</strong> requires a password that is hard to guess. Length and unrelated words count for more than mixing
          in capitals, numbers and symbols, so a password like <code>Password1234567!</code> is refused
          while <code>rope-rockstar-shone-colt</code> is accepted.
        </p>
        <p>
          Users change their passwords in <strong>Security</strong> on the{' '}
          <HelpLink to="/help/page-settings">Settings</HelpLink> page. Changing the password
          signs out all current browser sessions.

        </p>
        <p>
          <strong>Passkeys</strong> involve signing in with a fingerprint, face or device PIN instead of a typed
          password. This is supported as a convenience as it is often easier to use a passkey than opening
          a password manager to retrieve a stored password. Passkeys are device-specific and are
          in addition to a password; they do not replace it.
        </p>
        <p>
          Passkeys for signing in are separate from passkeys used to unlock the vault. Clicking a
          passkey&apos;s name renames it in {APP_NAME}, not in the device&apos;s own passkey list.
        </p>
        <p>
          <strong>Two-factor (an authenticator app)</strong> adds a one-time code after the password.
          When enabled the code is at every sign-in; there is no "trust this device" option. The code is
          remembered for the duration of the active session.  2FA is only used with passwords, using a
          passkey does not also ask for the authenticator code. If authenticator access is lost, the{' '}
          <strong>recovery codes</strong> displayed when authenticator use is enabled
          are the way back in, so save these in a password manager or somewhere equally safe.
        </p>
        <p>
          Two-factor is optional. It matters most when {APP_NAME} runs as a server that other devices
          sign in to: there, signing in is all that stands between someone who can reach the server
          and the data on it. When {APP_NAME} runs on the computer it is used from, anyone who can use that
          computer can read the database files directly, so sign-in protects use of the application
          rather than the data, and leaving two-factor off is reasonable.
        </p>
        <HelpHeading anchor="locked-out">Locked out</HelpHeading>
        <p>
          The administrator&apos;s password can be reset
          from the command line. This process is also described in the{' '}
          <a href="https://github.com/jeff162/luma#locked-out" target="_blank" rel="noreferrer">README&apos;s
            <em> Locked out</em> section</a>.
        </p>
        <div className="help-table-scroll">
          <table>
            <thead>
              <tr><th>Installation</th><th>Command</th></tr>
            </thead>
            <tbody>
              <tr>
                <td>Windows or Linux download</td>
                <td><code>luma --reset-password</code>, in the folder holding the program</td>
              </tr>
              <tr>
                <td>macOS</td>
                <td><code>/Applications/Luma.app/Contents/Resources/server/luma --reset-password</code></td>
              </tr>
              <tr>
                <td>Docker</td>
                <td><code>docker compose exec app python -m backend.desktop --reset-password</code></td>
              </tr>
              <tr>
                <td>Source checkout</td>
                <td><code>backend/venv/bin/python -m backend.desktop --reset-password</code></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          A list of accounts to choose from is provided and it asks for the new password. It is safe to run while{' '}
          {APP_NAME} is running. The chosen account ends up as an active administrator with two-factor
          off, and all current browser sessions are signed out. The vault passphrase is not affected; a
          forgotten vault passphrase is covered under{' '}
          <HelpLink to="/help/credential-vault">the credential vault</HelpLink>.
        </p>
      </>
    ),
  },
]

export const HELP_TOPICS_BY_ID = Object.fromEntries(HELP_TOPICS.map(t => [t.id, t]))
