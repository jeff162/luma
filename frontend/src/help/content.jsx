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
 * How the sections are chosen: most mirror a page in the left nav, in nav order, and lead with that
 * page's `page-*` hub topic -- the one its title's `?` opens, which also collects the page's related
 * topics as links. The rest are subjects that outgrew a single page and stand on their own
 * ("Duplicates & reconciliation", "General concepts"), because a topic does **not** have to sit
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
    key: 'rules',
    label: 'Rules',
    blurb: 'How categorization is kept up automatically, and what happens when two rules want the same transaction.',
  },
  {
    key: 'categories',
    label: 'Categories & tags',
    blurb: 'Two ways to organize transactions for reports: a category tree and cross-cutting tags.',
  },
  {
    key: 'recurring',
    label: 'Recurring transactions',
    blurb: 'Transactions that repeat on a schedule: what the scan finds on its own, and how to declare one it cannot see.',
  },
  {
    key: 'tasks',
    label: 'Tasks',
    blurb: 'The nag list: what gets raised there, and what dismissing one means.',
  },
  {
    key: 'accounts',
    label: 'Accounts',
    blurb: 'Where transactions come from, connecting data providers, and pairing up accounts that turn out to be the same one.',
  },
  {
    key: 'settings',
    label: 'Settings',
    blurb: 'The one page of preferences, and what each section of it covers.',
  },
  {
    key: 'administration',
    label: 'Administration',
    blurb: 'Running the installation: how it starts, who can sign in, and backups.',
  },
  {
    key: 'general-concepts',
    label: 'General concepts',
    blurb: `What holds for the whole ledger rather than one page: the single currency, where the data lives and how it is backed up, and who can reach it.`,
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
          A few things hold for the whole ledger rather than for any one page:
        </p>
        <ul>
          <li>
            All of the data remains local unless it is moved somewhere else; {APP_NAME} never makes an
            outgoing connection unless specifically requested (e.g. downloading transactions from a data
            provider, storing a backup on a cloud service). Where the data sits and how to keep a copy of
            it are covered in <HelpLink to="/help/data-and-backups">data on disk, and backups</HelpLink>.
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
        <p>
          After that, <HelpLink to="/help/keeping-up-to-date">keeping the ledger up to date</HelpLink> is
          a short routine.
        </p>
      </>
    ),
  },
  {
    id: 'parts-of-luma',
    section: 'getting-started',
    title: `The parts of ${APP_NAME}`,
    surfaces: ['Getting started'],
    summary: 'The major parts of the app in one table -- importing, accounts and owners, the ledger, categories and groups, tags, rules, recurring charges, the dashboard, tasks, settings and administration -- each saying what it is for and handing off to its own topic.',
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
                <td>Handle the the task of categorizing transactions as they are loaded.
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
                <td>Preferences, sign-in methods and the Trash.</td>
              </tr>
              <tr>
                <td><HelpLink to="/help/page-administration">Administration</HelpLink></td>
                <td>Startup configuration, sign-in protection, users, and Backup / Restore. For
                  administrators only.</td>
              </tr>
            </tbody>
          </table>
        </div>
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
            <strong>Most changes are reversible.</strong> Most actions can be
            undone, redone, or adjusted later, and several that look like deletions are really
            reporting switches: a group{' '}
            <HelpLink to="/help/exclude-from-totals">excluded from totals</HelpLink> still keeps its
            transactions, and a{' '}
            <HelpLink to="/help/removed-as-duplicates">removed duplicate</HelpLink> stays on its
            file's duplicate report, ready to restore. The few removals that are permanent say so
            before they happen.
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
    id: 'import-strategy',
    section: 'getting-started',
    title: 'Choosing how to bring data in',
    surfaces: ['Getting started'],
    summary: 'Transactions come from files, from a data connection, or from both, depending on what is available, what it costs and who sees the data. Amazon and PayPal exports add the purchase detail neither one carries.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          Transactions come from files, from a data connection, or from both. Which suits depends on
          what is available, what it costs, how much downloading is tolerable, and who else gets to see
          the transactions.
        </p>
        <ul>
          <li>
            <strong>Downloading from each bank.</strong> Most banks and card issuers offer a CSV
            export. It costs nothing and no one else sees the data, but staying current means a fresh
            file from each one: trivial for two accounts, a chore for a dozen. Moving from another tool
            usually starts with a file too, since its export often holds the whole history, further
            back than a connection can reach.
          </li>
          <li>
            <strong>An aggregated view&apos;s export.</strong> Some budgeting apps, and a growing number
            of banks and brokerages, can link accounts held elsewhere and show them in one place, often
            at no charge. Where one can export everything as a single CSV, many downloads become one.
            In exchange, that service sees every transaction from the linked accounts.
          </li>
          <li>
            <strong>A <HelpLink to="/help/data-providers">data provider</HelpLink>.</strong> Where one
            operates, a paid provider connects {APP_NAME} to the accounts directly. New transactions
            arrive with each sync, started by hand, and nothing is downloaded. The price varies by
            country, and the provider sees the transactions.
          </li>
        </ul>
        <p>
          None of this is fixed. Free tiers end, prices change and providers come and go, so the choice
          is worth revisiting, and mixing routes is normal: files once for the older history and a
          connection from then on is a common shape. Switching or overlapping is safe, because every
          import is compared against the ledger and history that arrives by two routes is not counted
          twice, provided each bank account maps to the same account in {APP_NAME} from both.
        </p>
        <p>
          Which accounts are worth bringing in at all is covered
          under <HelpLink to="/help/page-accounts">the Accounts page</HelpLink>.
        </p>
        <h4>Sources worth adding either way</h4>
        <p>
          A card or bank account records where money went, not always what it bought.
        </p>
        <ul>
          <li>
            An Amazon purchase reads as some form of <strong>AMAZON.COM</strong> and an amount,
            however the charge arrived. The{' '}
            <HelpLink to="/help/amazon-import">Amazon order export</HelpLink> adds the orders and,
            optionally, their items, which is what lets one order be split across categories.
          </li>
          <li>
            A purchase paid through PayPal reads as a &ldquo;PAYPAL&hellip;&rdquo; line. PayPal&apos;s
            own history names the purchase. The{' '}
            <HelpLink to="/help/paypal-statements">monthly statement PDFs</HelpLink> are the easy way
            to get that history; the activity CSV adds each purchase&apos;s item title.
          </li>
        </ul>
        <p>
          Neither has to wait for the account that paid: orders and PayPal transactions are matched
          with their card or bank transactions whichever side arrives first. The steps are
          in <HelpLink to="/help/purchase-detail">adding purchase detail from Amazon and
            PayPal</HelpLink>.
        </p>
        <h4>Arriving with categorized data</h4>
        <p>
          An export from another tool often carries a category on every row. Noting that the
          categories are present in the data, during the import or afterwards on the file&apos;s card,
          lets <HelpLink to="/help/imported-category-cleanup">Group imported categories</HelpLink> bring
          them in and <HelpLink to="/help/generate-rules">Generate rules</HelpLink> propose rules that
          file future imports the same way. That is a quicker start than the starter categories or
          categorizing from nothing.
        </p>
      </>
    ),
  },
  {
    id: 'keeping-up-to-date',
    section: 'getting-started',
    title: 'Keeping the ledger up to date',
    surfaces: ['Getting started'],
    summary: 'The routine once the accounts are in: bring in what is new, refresh the Amazon and PayPal detail, settle what the import could not, look over what arrived, and check Tasks.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          Once the accounts are in, the same handful of steps repeats, at whatever interval suits.
          Monthly is typical.
        </p>
        <ol>
          <li>
            <strong>Bring in what is new.</strong> <strong>Sync now</strong> for{' '}
            <HelpLink to="/help/data-providers">connections</HelpLink>; for files, download the export
            and drop it on the <strong>Data Import</strong> tab, or leave it in the data source&apos;s{' '}
            <HelpLink to="/help/watched-folders">watched folder</HelpLink>.
            Check <strong>Watched folders</strong> on the Import page for anything left for review.
          </li>
          <li>
            <strong>Refresh the detail sources.</strong> Re-export the recent Amazon orders and the
            latest PayPal statement, as described in{' '}
            <HelpLink to="/help/purchase-detail">adding purchase detail from Amazon and
              PayPal</HelpLink>. An export that overlaps the last one is fine.
          </li>
          <li>
            <strong>Settle what the import could not.</strong> A card in the import history says
            when something on it needs a decision &mdash; see <HelpLink to="/help/duplicate-report">the duplicate-detection
              report</HelpLink>, <HelpLink to="/help/amazon-reconciliation">Amazon
                reconciliation</HelpLink> and <HelpLink to="/help/paypal-reconciliation">PayPal
                  reconciliation</HelpLink>.
          </li>
          <li>
            <strong>Look over what arrived.</strong> The needs-review count on each card opens just
            those transactions. Correct the ones a rule filed wrongly, categorize the ones no rule
            caught, and mark the rest reviewed. Accepting the offered rule means the same payee is
            filed next time. See <HelpLink to="/help/reviewing-transactions">needs
              review</HelpLink>.
          </li>
          <li>
            <strong>Check <HelpLink to="/help/page-tasks">Tasks</HelpLink></strong> for anything else:
            a connection needing attention, a new recurring series, a bill whose amount changed.
          </li>
        </ol>
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
          The dashboard is a visual representation of the transaction data. There are various reporting views
          to investigate where money is going and surface spending patterns. The dashboard is also useful for
          verifying that transactions are correctly categorized and for digging into details behind anomalous patterns.
        </p>
        <p>
          Page controls:
        </p>
        <ul>
          <li>
            <strong>Report types:</strong> <strong>Expense, Income, Cash Flow</strong> select the type of report.
            Expense and Income are pie charts, Cash Flow is a
            Sankey diagram (<HelpLink to="/help/dashboard-cash-flow">cash flow</HelpLink>).
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
            The <strong>filter</strong> at the top of the page affects which transactions are included
            for all of the reports.
          </li>
          <li>
            The <strong>period</strong> selector at the top of the page sets the time frame for the{' '}
            <strong>Single period</strong> report. <strong>Compare</strong> chooses its two periods with its own
            selectors, and <strong>Trends</strong> chooses the months it covers with its own selector: the
            last 12 months, the last 2, 3 or 5 years, all of the data, or a single year.
          </li>
          <li>
            In the single period report, the <strong>Trend</strong> chart at the bottom of the page shows
            the same report over all of the data, with the selected period highlighted. Clicking a bar
            selects that bar's period, and the selector beside the chart groups the bars by month,
            quarter or year. For a period such as <strong>Year to date</strong>, it can also repeat that exact
            span in each earlier year.
          </li>
        </ul>
        <p>
          Every chart drills down. Clicking a group opens its categories, clicking a category opens
          the transactions behind it, and anything filed wrongly can be corrected from there. Using
          the dashboard to check the data is as much its purpose as reporting on it.
        </p>
        <p>
          The filter and period at the top of the page remain in effect when switching between the Dashboard
          and Transaction pages so that is another way to view the transaction being displayed by the
          Dashboard.
        </p>
        <p>
          Not everything is counted. Categories{' '}
          <HelpLink to="/help/exclude-from-totals">excluded from totals</HelpLink> are not included
          in any of the dashboard reports as this is how credit-card payments and transfers between accounts stay
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
    summary: 'Another way to view spending showing what came in against what went out. Single period uses a Sankey diagram; Trends displays money in and money out as bar graphs by year and by month.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          <strong>Cash flow</strong> combines spending and income into one graph. It is
          based on transaction dates as opposed to actual money movement. This means that a
          credit card transaction is treated as being paid for on the date of the purchase rather than the
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
          <strong>Trends</strong> displays cash flow as bars around a zero line &mdash; money in
          above it, money out below, with the net drawn across them and the average net marked. The
          top chart has a bar per year and the bottom chart a bar per month. The selector on the bottom
          chart chooses the months it covers, and clicking a year in the top chart shows that year's
          months. Clicking a month opens its transactions; double-clicking switches
          to the single-period view for that month.
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
          set of pre-defined quick filters for common tasks to display only transactions which <HelpLink to="/help/reviewing-transactions">need review</HelpLink> or
          or categorization, as well as selecting by other properties. The &#9662; selector picks a filter, clicking turns it on and
          off.  The filter bar and time period at the to of the page are also active. All of these combine
          to select what is visible.
        </p>
        <p>
          <strong>Bulk Edit</strong> turns the list into a selectable set, for categorizing, tagging,
          marking reviewed, trashing. <strong>Bulk Edit</strong> is also how several payments get linked
          together into a single purchase.
        </p>
        <p>
          The individual transaction rows support a right-click menu and &#128393; at the
          end of the row opens the transaction editor. The transaction editor also supports adding external documentation in the
          form of attachments.
        </p>
        <p>
          The <strong>Reimbursements</strong> button at the top of the page brings up a list of the
          un-resolved reimbursable transactions so expenses and payments can be paired.
        </p>
        <p>
          <strong>Tags</strong> opens the list of tags, where a tag is added, renamed, recolored or
          deleted (see <HelpLink to="/help/tags">how tags work</HelpLink>). <strong>Export&hellip;</strong>{' '}
          writes transactions to a CSV file (see{' '}
          <HelpLink to="/help/csv-export">exporting transactions to CSV</HelpLink>).
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
        <p>The flag clears three ways:</p>
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
          A transaction found by text that is not on screen is marked. A match in the imported text
          underlines the name with a dotted line, and hovering the name shows that text. A match in an item
          description underlines the <strong>Split (N)</strong> marker the same way, and hovering it lists the
          items. A match inside an attachment highlights the row&apos;s document marker, which opens the document.
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
          put the name in the search box and the amount in the <strong>💲 Amount</strong> filter beside it.
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
          (<code>$1,250.00</code>), and parentheses read as a minus, the way a statement writes a payment:
          <code> (42.10)</code>. For a range of amounts, use the <strong>💲 Amount</strong> filter beside the
          Transactions search box.
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
        <p>
          The editor opens five ways -- from the row's right-click menu
          (<strong>Split&hellip;</strong>, or <strong>Edit split&hellip;</strong> on one already split),
          from the <strong>Split (N)</strong> marker that a split row shows in its category column,
          from the <strong>Split&hellip;</strong> button beside the category in the transaction detail
          panel, from the same button on the <strong>+New</strong> panel while a transaction is being
          entered by hand, or from <strong>Split&hellip;</strong> on a <strong>Matched</strong> or{' '}
          <strong>No charge found</strong> row of the{' '}
          <HelpLink to="/help/amazon-reconciliation">Amazon reconciliation report</HelpLink>. All five land in
          the same dialog.
        </p>
        <p>
          On <strong>+New</strong> the amount comes first &mdash; a split divides it, so the button waits
          until one is entered. The items are held with the form rather than saved: the transaction and
          its items are recorded together when <strong>Add transaction</strong> is pressed, and the
          category box is replaced by a <strong>Split (N)</strong> marker that reopens the editor
          meanwhile. <strong>Remove split</strong> there returns the form to a single category.
        </p>
        <p>
          The split transaction editor reads as a small ledger &mdash; <strong>Description</strong>, <strong>Category</strong>, <strong>Amount</strong>,
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
          names every category the split touched instead, since that text is read rather than re-imported.
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
          See{' '}<HelpLink to="/help/re-categorizing">how transactions get categorized</HelpLink>.
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
        <p>*needs review*</p>
        <p>
          Some spending gets paid back, either at the time like a dinner out with friends, some at a later date
          such as work expenses or perhaps a set of tickets bought for friends. These are all transactions where
          the spending should not be reflected as an expense and the reimbursement should not be
          reflected as income.
        </p>
        <p>
          Tracking reimbursable expenses works by categorizing the reimbursable portion in a category
          that is a member of the system's <em>Reimbursable</em> group.{' '}
          <strong>Reimbursable</strong> is similar to the <strong>Transfers</strong> group. Both of them
          are created by the system, cannot be deleted, and are excluded from
          spending. <strong>Reimbursable</strong> is different in that the <strong>Reimbursements</strong> button
          on the Transactions page looks in this category for unresolved transactions that need to be
          joined as a reimbursement pair. Pairing is useful because it allows the system to generate alerts
          if repayment is not received in a timely fashion.
        </p>

        <h4>Creating categories</h4>
        <p>
          The <em>Reimbursable</em> group ships empty. It may be useful to name the categories so that they
          indicate <em>what the money is for</em> -- Concert tickets, Work expenses, Health care expense, etc.
          Using "Reimbursable" as a prefix (Reimbursable work expenses) makes it easy find the categories.
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
        <p>
          The repayment, when it arrives, is categorized into the reimbursable category too. That is what
          keeps it out of income, and how it is located when linking expenses and payments.
        </p>

        <h4>Linking payments and expenses</h4>
        <p>
          Linking ties related payments and expenses together to support tracking the outstanding
          amount. Linking also allows for naming the transaction set.
        </p>
        <p>
          The <strong>Reimbursement</strong> button at the top of the Transaction screen launches a
          report containing the unsettled transactions in the reimbursable group and supports pairing
          expenses and repayments. Dragging a payment to an expense pairs them. Multiple income
          transactions can be paired with a single expense.
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
          Clicking a row opens it: a paired one opens its record, an unpaired one opens its transaction.
          A drop that landed on the wrong row is taken back from the <strong>Undo</strong> on the
          notice that follows it &mdash; pairing changes nothing about the transactions, so undoing it
          leaves them exactly as they were.
        </p>
        <p>
          Where more than one person is set up as an owner, each expected row starts with a chip naming
          whose account the expense is on (hovering it shows the full name), and the pills above the
          columns narrow the <strong>Expected</strong> column to one person. <strong>Received</strong> is
          never narrowed, since a repayment can land on anyone&apos;s account.
        </p>
        <p>
          In the transaction list a <strong>&#8617;</strong> marker on a row opens its reimbursement
          directly, dimmed once that reimbursement is finished.
        </p>

        <h4>Changing what is paired</h4>
        <p>
          Both ways to undo a pairing are in the record itself. <strong>&times;</strong> beside a
          transaction removes that one; <strong>Stop tracking this reimbursement</strong> dissolves the
          record entirely. Neither recategorizes anything or moves money &mdash; the transactions stay
          as they are and the money owed back goes back to being untracked. Pairing them again is the
          undo. Removing the last transaction dissolves the record too, since it would then describe
          nothing.
        </p>
        <p>*needs review*</p>
        <p>
          While a record claims money in a transaction, that much has to stay in the{' '}
          <em>Reimbursable</em> group. Raising the reimbursable portion of a split is always allowed,
          and so is lowering it as far as what the record claims &mdash; anything below that, and
          recategorizing or un-splitting the row outright, is refused, naming the amount claimed. A
          record left claiming money its transaction no longer holds would report a balance owed that
          nothing backs. Removing the transaction from the record first, with the{' '}
          <strong>&times;</strong> above, releases the row to be categorized however suits.
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
          <strong>Mark complete</strong> closes the record. What it does depends on whether the two
          sides balance, and the button is emphasized only in the case where nothing has to be decided.
        </p>
        <p>
          A record that is fully repaid offers <strong>Mark complete</strong> on its row in the
          <strong> Reimbursements</strong> list as well, since that ending asks nothing: it moves no
          money and needs no category. Anything with money left over is completed in the record, where
          that money is given its destination.
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
    surfaces: ['Transactions (row marker)', 'Transactions (Stored documents)', 'Transaction detail (Documents)'],
    summary: 'Receipts and invoices can be attached to a transaction, or stored until the transaction arrives. Parsable text is searchable from the Transactions search box.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          For some transactions it can be useful to attach supporting documents. This could be to
          provide additional detail for a large expense or it could be just to store the receipt where it
          can be easily located later.
        </p>
        <p>
          Attachments are kept in the <strong>Documents</strong> section of the transaction editor, which
          opens from the pencil at the end of a transaction row or from <strong>Edit transaction&hellip;</strong> in
          the row's menu. Multiple documents can be attached to a single transaction.
        </p>
        <p>
          A row with attachments also shows a document marker. Clicking it opens the document directly
          when there is only one, or lists them to choose from when there are several.
        </p>

        <h4>Attaching a document</h4>
        <p>
          The Documents section has one box for adding documents, and it accepts them several ways:
        </p>
        <ul>
          <li>
            <strong>Drop a file</strong> onto the box, or pick one with <strong>Browse&hellip;</strong>.
          </li>
          <li>
            <strong>Paste an image</strong> -- a screenshot or a photo already on the clipboard. It is
            attached straight away.
          </li>
          <li>
            <strong>Paste text</strong> from the clipboard. For emailed receipts it may be easier to
            use copy/paste rather than saving the email as a file. Pasted text waits in the box to be
            trimmed, then <strong>Attach</strong> adds it.
          </li>
          <li>
            <strong>Stored documents (N)</strong> attaches a document that was stored before the
            transaction arrived. The button only appears when there are stored documents.
          </li>
        </ul>
        <p>
          A pasted document is named <code>documentation</code> with an extension for its kind, such
          as <code>documentation.png</code>. A file keeps its own name.
        </p>
        <p>
          Using copy/paste with an email usually brings its HTML formatting along, so an itemized table keeps
          each price beside its item. What the preview shows is what gets attached. A careful text selection
          keeps anything extraneous out of the attachment.
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
          they matched even though the search term is not visibly present.
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
    surfaces: ['Transactions (Tags)'],
    summary: "Tags are cross-cutting labels applied at the transaction, category, group, or account level. A transaction's effective tags are the union of all four sources.",
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          Tags are lightweight labels separate from the category tree. Use them for any cross-cutting
          dimension to report by &mdash; <em>Essential</em> vs everything else, who an
          expense belongs to in a household, business vs personal, vacation buckets, and so on. Tags can also be
          used as placeholders to build complicated expressions which cannot be expressed in the filter.
        </p>
        <p>
          Categories and groups belong to no one &mdash; one tree serves everyone in the ledger, while an
          account has an owner. So a dimension like personal vs shared, or business vs personal, is a tag
          rather than a second branch of the category tree or a split of an account.
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
          transaction that inherits it, and a strike-through <strong>hidden here</strong> entry in the picker
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
          alone. <HelpLink to="/help/re-categorizing">How transactions get categorized</HelpLink> covers
          which rows each action is allowed to touch.
        </p>
        <p>
          <strong>Rule checkup</strong> reports rules that compete with each other and charges that
          have drifted outside a rule's amount range. It changes nothing on its own, and carries a
          count when there is anything to look at. One of its checks reads the transactions rather than
          the rules, so the report takes a moment on a large ledger.
        </p>
      </>
    ),
  },
  {
    id: 're-categorizing',
    section: 'rules',
    title: 'How transactions get categorized',
    surfaces: ['Rules page'],
    summary: 'Imported and synced transactions are categorized by the rules as they arrive, with a file\'s own categories filling in only what the rules leave. The rules always come first, so it does not matter whether a rule or the file arrived first. Afterward, Categorize re-applies rules but never disturbs a category set by hand; applying a rule to its matching transactions is full-force and overrides even that. A closing section ranks the categorization sources for anyone who wants the full model.',
    body: () => (
      <>
        <h4>As transactions arrive</h4>
        <p>*needs review*</p>
        <p>
          Most categorization happens automatically as transactions arrive. Each imported or synced
          transaction runs through the categorization rules -- the same process triggered by
          the <strong>Categorize</strong> button on the Rules page. For CSV import this only happens
          if <strong>Apply categorization rules on import</strong> is selected, which it is by default.
        </p>
        <p>
          A file imported with <strong>use the categories present in the data</strong> can also bring its own
          categories, generally as part of an initial seeding from another tool. Rules still come first:
          the file's category fills in only rows no rule claims. That stays true afterward -- a rule
          created later takes those rows the next time <strong>Categorize</strong> runs, just as it would
          have at import. The file's label stays on every row either way.
        </p>
        <h4>Once transactions are in</h4>
        <p>
          After that, a category can change in a few ways, and the two bulk actions that
          re-categorize -- <strong>Categorize</strong> and a rule's <strong>apply to matching
            transactions</strong> -- treat a row's origin differently. The practical effect of each is
          below; a closing section ranks the sources in full for anyone who wants it.
        </p>
        <h4>Categorize</h4>
        <p>
          The <strong>Categorize</strong> button (on the Rules page) re-applies every rule
          across the whole ledger, but only to rows that are <strong>not pinned</strong> -- those
          categorized by a rule or by a trusted import, and those still uncategorized. It deliberately
          leaves alone anything categorized <em>by hand</em>. It only ever <em>sets</em>
          or <em>changes</em> a category, never removes one: a rule-assigned row that no longer matches
          any rule <em>keeps</em> its category, so deleting or narrowing a rule doesn't
          silently un-categorize the transactions it already handled. It is the pass to run after adding
          or changing rules, to refresh categorization without disturbing earlier work.
        </p>
        <p>
          To deliberately <em>undo</em> a rule's categorizations -- when a rule was wrong -- use the{' '}
          <strong>re-evaluate this rule's transactions</strong> option offered when a rule is deleted or
          edited. It re-runs just those rows against the remaining rules, so they fall to another matching
          rule, rather than keeping the removed rule's category. A row no remaining rule claims goes back to
          the category its file gave it, when it came from a file imported with <strong>use the categories
            present in the data</strong>, and otherwise to uncategorized.
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
          <li><strong>Rule</strong> -- assigned by a matching rule. Not pinned, so Categorize
            re-evaluates it (it can move to another rule, but is never cleared) and a full-force apply
            overwrites it; it is reverted only by the opt-in <em>re-evaluate</em> when the rule is deleted
            or edited.</li>
          <li><strong>Trusted import</strong> -- the category came from a file imported with
            <strong> use the categories present in the data</strong>, and no rule claims the row. Not pinned: any
            matching rule takes it, whether through Categorize or a rule apply, turning it into a rule
            categorization. The Generate-rules conflict screen can also re-categorize it in place -- see
            below.</li>
          <li><strong>Uncategorized</strong> -- no category yet; any rule is free to claim it. (A row whose
            imported category was <em>cleared</em> when a suggested rule was rejected sits here too: rules
            can categorize it, but the discarded file label is kept on the row and never re-applied.)</li>
        </ul>
        <p>
          The asymmetry is the part to remember: <strong>Categorize</strong> respects a manual
          category, while a rule's <strong>apply to matching</strong> does not.
        </p>
        <p>
          One deliberate exception lives on the{' '}
          <HelpLink to="/help/generate-rules">Generate-rules conflict screen</HelpLink>:
          re-categorizing a row there corrects the file's category and the row <em>stays</em> a
          trusted-import categorization (and keeps informing rule suggestions until a rule claims it).
          Only <strong>Preserve</strong> turns such a row into a manual exception. It is the one place a
          trusted-import categorization is edited while staying trusted-import.
        </p>
        <p>
          A <HelpLink to="/help/transaction-splits">split transaction</HelpLink> sits outside all of this.
          Its categorization is the set of items it was divided into, so both passes leave it alone --
          even a full-force rule apply, which reports how many it skipped rather than overwriting them.
        </p>
        <p>
          To check a single transaction's current source, open its detail panel: a small <strong>manual</strong>
          label sits beside a pinned category, and the details show a <strong>Categorized by</strong> line naming
          the source -- a rule, a manual edit, or the category present in the source data.
        </p>
      </>
    ),
  },
  {
    id: 'rule-precedence',
    section: 'rules',
    title: 'When two rules match the same transaction',
    surfaces: ['Rules page'],
    summary: 'Rules are not ranked manually; there is an internal ranking that puts scope first, then keyword length, then the narrower amount range. There are ambiguous situations which require decisions and the Rules checkup lists them: amount ranges that overlap without one containing the other, and two separate keywords that both turn up in one merchant name, each of which requires refining the conditions. It also lists merchant names where one contains the other, which is fine but does not always resolve the way it reads, rules which are essentially duplicates of each other where one can be deleted outright, and pairs that compete over nothing because both rules file the same way.',
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
            <strong>Rules that match the same transaction</strong> -- two keywords that are unrelated to
            each other, both turning up in one merchant name, such as <em>northgate</em>
            and <em>riverstone</em> in "NORTHGATE RIVERSTONE SUPPLY". The longer keyword wins, which
            settles nothing here: keyword length stands in for being more specific only where one
            keyword sits inside the other, and these do not. The finding carries the transaction it
            found and how many others like it there are, since without a real transaction matching both
            there would be nothing to report. The way to settle it is to narrow whichever keyword is
            reaching further than intended.
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
          left is what still wants a decision. Nothing is lost: <strong>Show dismissed</strong> brings the
          acknowledged set back, and each one can be restored. A dismissal covers the situation it was
          made about rather than the pair of rules forever, so an edit that changes what the finding says
          -- a narrower rule that becomes surplus and can now be deleted -- raises it again.
        </p>
        <p>*needs review*</p>
        <p>
          <strong>Competing rules that file the same way</strong> is the last section, and it holds
          pairs from either of the two sections above whose two rules apply the same category, rename,
          tags and recurring setting. Those pairs contend over an outcome that is identical whichever
          rule wins -- two spellings of one merchant filing to one place is the usual shape -- so
          nothing needs refining and they can be dismissed. A dismissal there lapses if the two rules
          ever stop agreeing, which puts the pair back among the warnings.
        </p>
        <p>
          <strong>Overlapping ranges and rules matching the same transaction cannot be dismissed.</strong>{' '}
          The outcome in both cases is arbitrary rather than undecided: the same rule wins every time,
          but for a reason that has nothing to do with the two rules in question -- which range happens
          to be arithmetically smaller, or which keyword happens to be longer. An acknowledgement would
          leave the ledger categorized by that accident with the report calling it settled, so these stay
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
    surfaces: ['Import (rule suggestions)'],
    summary: 'Generate rules studies a file whose transactions are already categorized and proposes rules that reproduce that categorization on future data; the output is rules, not a re-categorization of the file. When one merchant is filed under several categories the suggestions form a conflict set, which can be resolved in different ways for different results.',
    body: () => (
      <>
        <p>
          If the data comes from another tool where the transactions already carry meaningful categories,
          tell {APP_NAME} the import's category data is useful (turn on <strong>use the categories present in the data</strong>
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
            rows too, and they shift from their file category to
            rule-governed (see{' '} <HelpLink to="/help/re-categorizing">how transactions get categorized</HelpLink>).
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
            under <strong>discard and&hellip;</strong> choose what happens to the rows it covered:
            <ul>
              <li>
                <strong>keep categorization</strong> leaves them exactly as imported -- the file's category
                stays, and a matching rule created later still takes them, as it would any imported row.
                This is the choice for a file category that is right but not worth a rule (an annual fee
                filed under its own category). To keep a row out of every rule's reach, set its category by
                hand instead.
              </li>
              <li>
                <strong>remove categorization</strong> clears the category
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
            stay trusted-import categorizations, so they keep informing the suggestions.</li>
          <li><strong>Keep an outlier as a one-off.</strong> <strong>Preserve</strong> a genuinely
            distinct row to record it as a manual exception: rules leave it alone and it drops out of
            the suggestions entirely, rather than re-surfacing as a conflict.</li>
        </ul>
        <p>
          The last two produce subtly different results: a bulk re-categorize
          keeps rows in the import learning set and re-targets the rule, while Preserve carves a
          row out as an untouchable manual decision. How those properties affect subsequent behavior is covered
          in <HelpLink to="/help/re-categorizing">how transactions get categorized</HelpLink>.
        </p>
        <h4>Older suggestions, and clearing them out in bulk</h4>
        <p>
          Rules are forward-looking, so a merchant pattern with no recent activity is unlikely to recur.
          As an aid when importing older transaction history, suggested rules whose newest matching transaction
          falls outside the <strong>Look back</strong> window move
          off the main <strong>Pending</strong> list onto a separate <strong>Older</strong> pill, so the pending count
          reflects only patterns that are still live. Nothing is lost -- widening the look-back window
          brings them back, and the underlying rows are untouched by the lens itself.
        </p>
        <p>
          Because older suggestions are already out of the way, settling them is optional -- a stale tail
          can simply be left alone. Alternatively, open the <strong>Older</strong> pill, select several
          rows at once, and apply a bulk disposition:
        </p>
        <ul>
          <li><strong>Discard, keep categories</strong> marks them
            reviewed while leaving their rows exactly as imported (for a pattern not
            worth a rule)
          </li>
          <li>
            <strong>Discard, clear categories</strong> additionally clears those rows so future rules may categorize them
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
    title: 'The Accounts page',
    surfaces: ['Accounts'],
    summary: 'Accounts and Owners. Transactions identify the account they came from, and owners are matched to accounts for reporting. ',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          <strong>Accounts</strong> are created during the import process. The various sources of transaction data tend to
          either supply account information with the transaction or all the transactions are from a single
          account and the user identifies that account when the data is imported.
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
        <p>
          Membership is <strong>recomputed on every scan</strong>: it is a cache of what currently matches,
          not a hand-kept list.
        </p>
        <ul>
          <li>
            <strong>Remove from the series</strong> -- for a transaction the scan swept in by mistake. It stays
            out across future scans. An <strong>Amount changed</strong> finding offers the same thing
            as <strong>Exclude from series</strong>. A removal is reversible: undo it from the prompt, from the removed
            transaction's own right-click menu (<strong>Restore to recurring series</strong>), or from
            the <strong>removed</strong> list inside the series.
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
          <strong>Matching by amount.</strong> A series normally ignores amount when deciding what belongs.
          When one payee bills two things in the same category that only the amount tells apart -- two
          subscriptions at different prices -- the <strong>Amount</strong> button on the series card turns on
          matching by amount: only charges within or near the range the series has charged join it, or a
          range can be set by hand instead. A series defined by a rule has no Amount button; the rule's own amount condition does
          the same job and is changed by editing the rule.
        </p>
        <p>
          A transaction carries a small ↻ marker while it belongs to a series, and its editor links through
          to that series. Right-clicking a transaction offers <strong>Mark as recurring</strong>, <strong>Remove</strong>,
          or <strong>Restore</strong>, whichever fits.
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
          under <strong>Transfer &amp; payment review</strong> on the Recurring page: where more than one
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
          <strong> Series</strong> list itself, <strong>Needs attention</strong>, and <strong>Upcoming</strong>. The count beside
          <strong> Needs attention</strong> is how many findings are open.
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
          dismissed stays listed at the foot of the section and can be brought back.
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
          <HelpLink to="/help/re-categorizing">how transactions get categorized</HelpLink>.
        </p>
      </>
    ),
  },
  {
    id: 'page-import-export',
    section: 'importing',
    title: 'The Import page',
    surfaces: ['Import'],
    summary: 'Where transactions come in. The Data Import tab takes files and syncs and keeps a card per file or sync recording what it did. File Sources and Connections are where each is set up.',
    body: () => (
      <>
        <p>*needs review*</p>
        {/* A map of the page rather than a prose tour: the page carries more topics than any other, and
            what a reader wants here is which control leads to which one. Grouped by tab, since the tabs
            are how the page itself is divided. */}
        <p>
          Where transactions come in. The page has three tabs, and the sections
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
                  of the ledger; they are listed with the file&apos;s rejected rows instead.</td>
              </tr>
              <tr>
                <td><strong>Data connections</strong></td>
                <td>Shown once a <HelpLink to="/help/data-providers">data provider</HelpLink> is
                  connected. <strong>Sync now</strong> pulls new transactions from every connection,
                  and <strong>Connections</strong> lists each one with when it last synced and anything
                  waiting on it. Connecting and mapping are on the Connections tab.</td>
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

        <HelpHeading anchor="connections-tab">Connections</HelpHeading>
        <p>
          Where a <HelpLink to="/help/data-providers">data provider</HelpLink> is linked
          and maintained. This is also where the mapping of accounts from the provider to accounts in
          the application occurs. <strong>Sync now</strong> pulls new transactions from every connection,
          and what each sync brings in joins the import history on the Data Import tab &mdash; <strong>View
            in import history</strong>, on a finished sync, opens the cards it added to.
        </p>
      </>
    ),
  },
  {
    id: 'data-providers',
    section: 'importing',
    title: 'Data providers and connections',
    surfaces: ['Import (Connections)', 'Import (Data Import → Data connections)'],
    summary: `A data provider is an online service that fetches transactions directly from some source of interest.`,
    body: () => (
      <>
        <p>
          A <strong>data provider</strong> is an online service that retrieves transactions from various sources
          so they arrive in {APP_NAME} without exporting and importing a file. The
          supported providers are <strong>Plaid</strong> and <strong>SimpleFIN Bridge</strong>. There are
          no credentials supplied in {APP_NAME}. SimpleFIN Bridge is a subscription model and provides access to most
          financial institutions. Plaid offers a developer license which allows
          a limited number of connections to be built.
        </p>
        <p>
          The <strong>data provider</strong> defines the model. With SimpleFIN Bridge, the accounts are
          connected on the SimpleFIN Bridge webpage and the <strong>connection</strong> provides the transaction data from
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
          the <strong>Import</strong> page. Connection settings and Disconnect connection are on
          the per-connection menu.
        </p>
        <h4>Secrets Vault</h4>
        <p>
          The credentials a connection stores on disk are encrypted in
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
          The mapping, and the set of extra details to capture can be changed
          from <strong>Connection settings&hellip;</strong> in the card's menu. An account added at the
          provider later has to be mapped as well (see <em>When a connection needs attention</em> below).
        </p>

        <h4>Syncing</h4>
        <p>
          New transactions are pulled on request using the sync control in the navigation pane or
          from <strong>Sync now</strong> on the <strong>Data Import</strong> or <strong>Connections</strong> tab
          of the Import page. Per-connection Import cards on the Import page records
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
            <HelpLink to="/help/data-and-backups#restoring-both">restoring data and
              credentials</HelpLink>).
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
          refresh.
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
            expired at the provider. Syncing stays stopped until it is connected again.
          </li>
          <li>
            A <strong>provider notice</strong> is a problem the provider reported that did not stop the
            sync, such as one bank on a multi-bank connection needing attention.
          </li>
          <li>
            <strong>To map</strong> means an account was added at the provider after the initial
            mapping. Its transactions are skipped until it is mapped
            from <strong>Connection settings&hellip;</strong> in the card's menu.
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
        <p>
          Disconnecting retains the accounts and their transactions. If disconnecting the
          account revokes the provider's access the confirmation page will indicate this.
          For Plaid, {APP_NAME}'s own access (its client ID and secret) is kept; it can be revoked only
          by signing into the Plaid Dashboard.
        </p>
      </>
    ),
  },
  {
    id: 'credential-vault',
    section: 'importing',
    title: 'The credential vault',
    surfaces: ['Import (Connections, the vault strip)'],
    summary: 'The vault encrypts the data provider credentials stored on disk. It is opened with a passphrase or a passkey, and has to be open to connect or sync.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          The vault encrypts the credentials a{' '}
          <HelpLink to="/help/data-providers">data provider</HelpLink> connection stores on disk.
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
                <td>Shown before a vault exists. The passphrase protects the key the credentials are
                  encrypted with, so it has to be a strong one: long enough, and hard to guess. How hard
                  is estimated as it is typed, against lists of common words, names and patterns, and
                  the dialog says what would make it stronger. Several unrelated words work well, and
                  the dialog can suggest some.</td>
              </tr>
              <tr>
                <td><strong>Your vault passphrase is too easy to guess</strong></td>
                <td>Shown when a passphrase set under an earlier, weaker rule no longer passes the current
                  one. It is checked each time it is typed to unlock. When the rule, or the estimate behind
                  it, changes, the locked strip and a <strong>Confirm your vault passphrase</strong> task
                  ask for one unlock with the passphrase rather than a passkey, since a passkey cannot be
                  used to check it; no credentials backup can be taken until then. It still opens the vault, but no
                  data provider can be connected, and no credentials backup can be taken, until it is
                  changed in Vault settings. Only the person whose passphrase it is can change it.</td>
              </tr>
              <tr>
                <td><strong>Unlock with a passphrase</strong>, <strong>Unlock with a passkey</strong></td>
                <td>Shown while the vault is locked. The passkey button appears once a passkey has been
                  added in <HelpLink to="/help/vault-settings">Vault settings</HelpLink>.</td>
              </tr>
              <tr>
                <td><strong>Lock</strong></td>
                <td>Closes the vault now. Left alone it locks after eight hours without use, and when
                  the application restarts. An unlock belongs to the browser it was made in; another
                  browser or device unlocks separately.</td>
              </tr>
              <tr>
                <td><strong>Vault settings</strong></td>
                <td>Shown while the vault is unlocked: the unlock methods, the recovery code, who else
                  can open the vault, and replacing the key. See{' '}
                  <HelpLink to="/help/vault-settings">Vault settings</HelpLink>.</td>
              </tr>
              <tr>
                <td><strong>Request vault access</strong></td>
                <td>Shown to a user of an installation where someone else has already created the vault.
                  The request sets that user&apos;s own passphrase, and then waits until someone who can
                  already open the vault approves it in Vault settings. The strip tells that person a
                  request is waiting.</td>
              </tr>
              <tr>
                <td><strong>Can&apos;t open it?</strong></td>
                <td>Shown while the vault is locked, for a forgotten passphrase. It lists the ways back
                  in, cheapest first: a passkey, another person who can open the vault, the recovery
                  code, a credentials backup. The last resort rebuilds the vault. That keeps the ledger
                  and each connection&apos;s account mapping, and every connection has to be
                  reconnected.</td>
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
    surfaces: ['Vault settings (Import, Connections)'],
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
          last remaining method cannot be removed.
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
          administrator.
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

        <HelpHeading anchor="exposure">Respond to an exposure</HelpHeading>
        <p>
          For when the database or a backup may have been copied. <strong>Replace connection
            credentials&hellip;</strong> has each provider issue a new credential where the provider
          supports that, so the copied ones stop working and the connections keep syncing. The rest are
          listed with what to do at the provider. It is the first step
          of <HelpLink to="/help/copied-database">responding to a copied database</HelpLink>.
        </p>
      </>
    ),
  },
  {
    id: 'csv-export',
    section: 'transactions',
    title: 'Exporting transactions to CSV',
    surfaces: ['Transactions (Export…)', 'Copy transactions (Download CSV)'],
    summary: 'A CSV export writes the transactions matching a filter, with the chosen columns, in roughly the shape they were imported. It is not a backup: splits, tags, rules and attachments stay behind.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          <strong>Export&hellip;</strong> on the Transactions page writes the transactions matching a
          filter to a CSV file, one row per transaction, with the columns ticked below the filter. The
          filter starts as a copy of the page&apos;s own, and changing it leaves the page as it was. With
          no filter set, every transaction is written. For a list too large to copy, the{' '}
          <strong>Copy transactions</strong> dialog offers the same file as <strong>Download CSV</strong>.
        </p>
        <p>
          A CSV export gives the data back roughly as it was imported, with some of the work done since
          &mdash; renames, categories, notes. It cannot carry all of it, and is not a way to move or keep
          the data: a <HelpLink to="/help/data-and-backups">backup</HelpLink> is.
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
          The folder is read on the machine that runs the application. On a desktop installation that is
          the same machine the page is open on. On a server, or in a container, it is a folder there
          &mdash; a container additionally needs it mounted, or the path names nothing.
        </p>
        <h4>Proving the setup first</h4>
        <p>
          A data source imports on its own only after one of its files has been imported by hand. The
          mapping screen is where a source learns which account each value in the file belongs to, so
          until one file has been through it there is nothing for an unattended import to apply. Set the
          source up, import one export the usual way, then point it at the folder.
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
          <li>a data source set up to create a new account as part of importing</li>
          <li>a file whose columns are not the ones the data source expects, which usually means a file
            from somewhere else landed in the folder</li>
        </ul>
        <p>
          The fix is made wherever it belongs &mdash; mapping the missing account from the data
          source&apos;s row on the <strong>File Sources</strong> tab, for instance. The next check picks the file up on its own and the task
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
          those paths belong to the other machine. Turning it back on is a decision about where the
          folders are here.
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
            <strong>Check the reconciliation.</strong> Each order or PayPal payment is matched with the
            card or bank transaction that paid for it, and that transaction is moved out of the totals
            so the purchase counts once. The import&apos;s card says when a match needs a decision
            &mdash; see <HelpLink to="/help/amazon-reconciliation">Amazon
              reconciliation</HelpLink> and <HelpLink to="/help/paypal-reconciliation">PayPal
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
            transaction. A charge that arrives later &mdash; the card synced or imported after the Amazon
            file &mdash; is matched then, when it is the order's only candidate. These orders count toward the
            import's needs-attention total so a stray one gets a look;
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
                Settings → Trash's <strong>Transactions</strong> section.
              </li>
              <li>
                <strong>Discard</strong> on a stacked duplicate row works per-copy.
                Discarded rows land in Settings → Trash's <strong>Duplicate transactions</strong>.
              </li>
              <li>
                <strong>Mark reviewed</strong> acknowledges it so it drops out of the attention
                count (Undo restores it) &mdash; for a charge that is just a purchase the export
                didn&apos;t cover, with nothing to fix. Works per row or on a bulk selection.
              </li>
            </ul>
          </li>
          <li>
            <strong>Matched</strong> &mdash; the order and the charge(s) it excluded. If a pairing is wrong
            (a coincidental same-amount charge, or a suggestion you accepted that turned out not to be this
            order's), <strong>Unlink</strong> detaches the charge &mdash; its original category is
            restored and the order returns to <strong>No charge found</strong>, where <strong>Link charges…</strong>
            can pair it correctly. An unlinked charge is never matched to that order again automatically.</li>
        </ul>
        <p>*needs review*</p>
        <p>
          <strong>Matched</strong> and <strong>No charge found</strong> rows also offer{' '}
          <strong>Split&hellip;</strong> (<strong>Edit split&hellip;</strong> once split), so an order can be
          divided across categories while it is being reviewed, without finding it again in the ledger &mdash;
          see <HelpLink to="/help/transaction-splits#imported-order">splitting an imported order</HelpLink>.
          An order with a single item has nothing to divide and doesn&apos;t offer it; the ledger&apos;s own{' '}
          <strong>Split&hellip;</strong> still does.
        </p>
        <p>
          Hover any order or charge for its <strong>origin detail</strong> (source file, captured fields,
          imported category), and use the <strong>↗</strong> beside an order to open the Amazon page for
          that order.
        </p>
        <h4>How an order&apos;s charge is found</h4>
        <p>*needs review*</p>
        <p>
          An order is matched to a charge of the same amount within three days of it, and only when exactly
          one such charge qualifies. Which accounts qualify depends on what the order says about how it was
          paid. A card mapped to an account on the{' '}
          <HelpLink to="/help/amazon-funding-sources">Amazon import form</HelpLink> limits the search to
          that account, and the mapping follows the card if its account is later merged into another.
          Without a mapping, the card&apos;s last four digits rule out accounts whose card number
          disagrees. An order that names no card at all (a digital order, or one paid off-card) has
          neither, so the charge must at least read as Amazon (<em>AMZN</em> or <em>AMAZON</em>);
          otherwise any same-amount charge nearby, on any account, would do.
        </p>
        <p>
          The cost of that rule is a miss: an off-card order whose charge reads as something else &mdash;
          paid through PayPal, so the card says <em>PAYPAL</em> &mdash; lands in{' '}
          <strong>No charge found</strong>, and <strong>Link charges&hellip;</strong> pairs it by hand. A
          miss is easy to see and fix; a wrong match would quietly exclude an unrelated charge from the
          totals.
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
          Each statement becomes its own card under the PayPal data source. A transaction already in the
          ledger &mdash; from a data connection or an earlier CSV &mdash; is recognized as a duplicate and enriched
          with the statement&apos;s detail. A statement imported before is skipped, as is a month with no activity.
          A payment in another currency is not imported, nor the card deposit that paid for it, so the card
          charge stays the record of that purchase. The activity CSV carries each purchase&apos;s item title,
          which the statement lacks.
        </p>
        <p>
          A statement also names the payment each refund returns, so the refund is paired with that payment
          and takes its category: categorizing the purchase moves the refund with it, and the two cancel out
          in that category. This holds across statements, imported in any order, and for a payment imported
          from the activity CSV. A category set by hand on the refund itself ends the pairing&apos;s hold on
          it. Both transactions carry the 🔗 link marker, which names the other one and opens it. A refund sent straight back to the card or
          bank it came from leaves a withdrawal, which moves to <em>Money movement</em>. A deposit or
          withdrawal has no name of its own, so the ledger shows what kind of transaction it was in its place.
        </p>
      </>
    ),
  },
  {
    id: 'paypal-reconciliation',
    section: 'importing',
    title: 'PayPal reconciliation',
    surfaces: ['Import history (Reconciliation pill)', 'Tasks'],
    summary: 'A tracked PayPal account is matched with the card and bank transactions on the other side of the same money, so a purchase counts once.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          A tracked PayPal account holds the record of what was bought or received &mdash; money can sit in a
          PayPal balance, and then the PayPal transaction is the only record there is. What PayPal took from a
          card or bank, or sent back to one, also appears on that account as a &ldquo;PAYPAL&hellip;&rdquo;
          transaction. Counting both would count the purchase twice, so after every import and sync each PayPal
          transaction is <strong>matched</strong> with the one on the other side, and the money counts once:
        </p>
        <ul>
          <li>
            A <strong>payment</strong> paid directly from a card or bank counts on the PayPal side, and the card
            or bank transaction moves to <em>Money movement</em>. When the PayPal transaction was already filed as
            a transfer, the card transaction is the one counted and nothing changes.
          </li>
          <li>
            A <strong>transfer</strong> &mdash; money added to PayPal from a bank or card, or withdrawn to one
            &mdash; is money moving on both sides, so both transactions move to <em>Money movement</em>.
          </li>
        </ul>
        <p>
          A match is made only when it is unambiguous: one matching amount within a few days, on an account
          belonging to the same person or a shared one. The <strong>PayPal reconciliation</strong> shows the
          result, for one import or sync from its card&apos;s <strong>Reconciliation</strong> pill (a collapsed
          data source or connection shows <strong>&#9888; N to resolve</strong> when one of its cards needs a
          look), or for the whole ledger from the Tasks entry:
        </p>
        <ul>
          <li><strong>Several possible matches</strong> &mdash; more than one transaction could be the other side.
            <strong> Pick&hellip;</strong> the right one, or <strong>None of these</strong>.</li>
          <li><strong>Two transactions, one match</strong> &mdash; one transaction that could equally be
            the other side of either of two PayPal transactions, and only one of them can have it &mdash; usually
            because the other payment came from the PayPal balance, or its own bank transaction isn&apos;t in the
            ledger. Both are listed together against it; <strong>Pick this one</strong> beside the one it belongs
            to settles the pair, and the other drops off the list with nothing to match. <strong>Neither</strong>
            when it belongs to none of them.</li>
          <li><strong>Matching transaction not found</strong> &mdash; a PayPal deposit or withdrawal with nothing found on the other
            side. <strong>Link&hellip;</strong> one by hand, or <strong>Mark reviewed</strong> when that account
            isn&apos;t tracked.</li>
          <li><strong>No PayPal record</strong> &mdash; a &ldquo;PAYPAL&hellip;&rdquo; transaction on an account
            that pays into PayPal that no PayPal transaction accounts for &mdash; often a gap in the PayPal
            history. It still counts as it is; <strong>Mark reviewed</strong> once checked.</li>
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
    summary: `When the same activity arrives multiple times, this report identifies the clear cases and groups the rest into categories. Review is an undecided match that needs a decision, and the only category counted as pending work (the file's "to review" count and the Tasks warning). Matched · review and Rejected · review are already rejected and advisory: examine one, Import anyway if it shouldn't have been rejected, or Mark reviewed. Everything else is settled. Hover over a pill for a short explanation.`,
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
            category that counts as <strong>pending work</strong>: it drives the "Possible duplicate
            transactions" item on the Tasks page. The file card's own "to review" count is wider &mdash; it
            adds the advisory rejects below, which want a look but never reach the Tasks page.</li>
          <li><strong>Matched &middot; review</strong> and <strong>Rejected &middot; review</strong> &mdash;
            the <strong>Matched nearby date</strong> and <strong>No specific match</strong> outcomes of a
            covered range. These were already rejected at import and are <em>advisory</em> &mdash; they do
            <em> not</em> count as pending work. Examine them to confirm the rejection was right; a row
            that should <em>not</em> have been rejected can be retained with <strong>Import anyway</strong>,
            and the rest can be left alone or cleared from the pills with <strong>Mark reviewed</strong> (in
            bulk). Often a <strong>No specific match</strong> transaction can be matched to a transaction
            further out (search by the amount) than the pairing window reaches, but sometimes it really is a
            transaction which should be included. The remaining covered-range outcomes &mdash;{' '}
            <strong>Matched another account</strong> and <strong>Matched transfer</strong> &mdash; are settled
            and ask for nothing; they carry their own filters beside <strong>Removed later</strong>. See{' '}
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
          "Rejected": it was recognized as one already held and contributed its detail, not
          discarded. A row whose covered-range outcome has a name of its own keeps that name instead &mdash;
          enriching a <strong>Matched &middot; review</strong> row does not settle the question the review is
          asking. The additional information becomes part of the hover text displayed when hovering
          over the merchant name and is available for use in rules and when searching for
          transactions.
        </p>
        <p>
          Both directions are reversible. A row rejected at import never reached the ledger,
          and <strong>Import anyway</strong> brings it in. A transaction that was imported and removed
          afterwards is listed under <strong>Removed later</strong>, and <strong>Restore</strong> puts
          it back &mdash; see{' '}
          <HelpLink to="/help/removed-as-duplicates">a transaction that was imported, then
            removed</HelpLink>.
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
    title: 'Reviewing covered-range duplicates',
    surfaces: ['Duplicate-detection report'],
    summary: 'A row landing inside a date range an earlier import already covered is rejected as a presumed duplicate, and is then paired against the ledger to name what it duplicates \u2014 the exact day first, then \u00b11, then outward to a week, then across other accounts. Most outcomes are settled and need nothing. Two ask for a look: Matched \u00b7 review (the counterpart sits several days off) and Rejected \u00b7 review (nothing paired at all, so the row may be genuinely missing).',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          An import is allowed to be missing transactions at the edges, but it is assumed that after seeing
          a transaction from a given source, the import contains all the transactions from that source up
          to the end of the time period covered by the import (again, allowing for fuzziness at the edges).
          A later import landing inside that range is therefore rejected as a presumed duplicate, and{' '}
          {APP_NAME} looks for the transaction it duplicates: by date and amount on the same account
          &mdash; the exact day, then &plusmn;1, then outward a day at a time to a week &mdash; and, failing
          that, on other accounts.
        </p>
        <p>
          Re-importing a file, or importing a second export that overlaps the first, puts every overlapping
          row through this. Most of them pair cleanly and are settled where they stand. The report&apos;s{' '}
          <strong>Kind</strong> column names the outcome.
        </p>

        <p><strong>Worth a look</strong> &mdash; these two carry the amber pills:</p>
        <ul>
          <li><strong>Matched &middot; review</strong> &mdash; a counterpart turned up only after the date
            window widened past the exact day; each row states how far apart the two are. Posting dates drift
            between sources for several reasons &mdash; pending vs. posted timing, weekend or holiday
            settlement, and time-zone differences on foreign charges &mdash; so the same transaction can sit
            several days apart in two sources, and the further apart the pair sits the more it is worth a
            glance before clearing. Once the pair looks right, <strong>Mark reviewed</strong> clears it from
            the needs-attention list. If a pair turns out <em>not</em> to be the same transaction, select the
            rows and import both.</li>
          <li><strong>Rejected &middot; review</strong> &mdash; the date is covered but nothing paired with
            it at all, anywhere in the window or across accounts. That makes it the row to actually
            investigate: it is usually present in one source and genuinely missing from the other, in which
            case <strong>Import anyway</strong> keeps it. A row with a payee name gets one more check first:
            when the same payment &mdash; the same amount and a distinctive part of the name &mdash; already
            sits on another account within a couple of weeks, the row stays rejected and reads{' '}
            <strong>Matched another account</strong>; when nothing does, it is a payment the earlier source
            never saw (a subscription paid from a wallet balance, say) and it imports. What is left here is
            mostly money movement with no payee &mdash; deposits, withdrawals, currency conversions,
            holds.</li>
        </ul>

        <p>
          <strong>Settled</strong> &mdash; named so a rejection can be audited, but asking for nothing. Each
          has its own filter beside <strong>Removed later</strong>:
        </p>
        <ul>
          <li><strong>Matched</strong> &mdash; paired on the exact date or &plusmn;1 day. Where the row
            carried detail its match lacked, that detail was folded in and the row reads green.</li>
          <li><strong>Matched another account</strong> &mdash; the same charge, in the same direction,
            already sits on another account within a couple of weeks, matched on a distinctive part of the
            name. One payment recorded twice by two sources: an aggregator&apos;s export and a card&apos;s own
            download both carry the card charge behind a wallet purchase. The money left once, so the second
            copy is not a new transaction. This is the ordinary outcome when two exports overlap.</li>
          <li><strong>Matched transfer</strong> &mdash; an equal-and-opposite row naming this account sits on
            another one, a few days apart: a wallet deposit whose funding charge is already recorded. Two
            legs of one movement, and the other leg is on the books, so this one is correctly not
            re-imported. Because the twin is the <em>other</em> leg rather than the same transaction, its
            detail is never folded into it.
            <p>
              The account&apos;s name is looked for in the other row&apos;s name, its original statement
              name and any text captured from its file, so renaming a row never hides it from this match.
              Renaming can help: a bank&apos;s card-payment row renamed to name the card it pays off lets
              that payment pair the way a wallet&apos;s funding leg does. A rename affects later imports and
              a reopened report, not a rejection already recorded.
            </p></li>
        </ul>
        <p>
          Neither settled outcome is a verdict of its own: the coverage rule had already rejected the row,
          and the cross-account lookups run afterwards only so the report can name something rather than
          report nothing. Both are counted in the file card&apos;s duplicates total.{' '}
          <strong>Import anyway</strong> stays available on both, for the rare row that really is separate.
        </p>
        <p>
          A stored verdict names the accounts as they stood on import day. Merging two accounts afterwards
          does not revisit it, so an old report can describe a split that has since been healed.
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
          refused, so the view states the full count whenever it is showing part of one.
        </p>
      </>
    ),
  },
  {
    id: 'removed-as-duplicates',
    section: 'duplicates',
    title: 'A transaction that was imported, then removed as a duplicate',
    surfaces: ['File ledger (↗)', 'Duplicate-detection report (Removed later)'],
    summary: 'Most duplicates are caught during the import. One removed afterwards, by a decision on the duplicate report or an account merge, stays on its import\'s duplicate report under Removed later, where it can be restored.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          Most duplicates are caught during the import and never reach the ledger. A few are removed
          afterwards: the older copy when a{' '}
          <HelpLink to="/help/cross-account-duplicates">Review</HelpLink> row is settled
          with <strong>Replace existing</strong>, the newer one when it is settled
          with <strong>Discard new</strong>, the copies an account{' '}
          <HelpLink to="/help/merging-accounts">merge</HelpLink> finds, or a doubled charge merged on
          the <HelpLink to="/help/amazon-reconciliation">Amazon reconciliation report</HelpLink>. Such a transaction was in its
          file&apos;s ledger and no longer is.
        </p>
        <p>
          It stays on the <HelpLink to="/help/duplicate-report">duplicate report</HelpLink> of the import
          it came from, under <strong>Removed later</strong>. A Replace removes the older copy, so that
          can be a different file from the one where the decision was made.
          The <strong>Removed as duplicates</strong> line in that file&apos;s ledger
          (the <strong>↗</strong>) opens the report on just those rows.
        </p>
        <p>
          <strong>Restore</strong> on the row puts it back. Detaching a merged account restores every
          removal the merge made.
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
          <li>an error recorded in the log file</li>
        </ul>
        <p>Anything which might require attention will appear here.</p>
        <p>
          <strong>Dismiss</strong> hides the notification until
          something changes. For instance, if the note about uncategorized
          transactions is dismissed, the task reappears when new ones are added to the list.
        </p>
      </>
    ),
  },
  {
    id: 'page-settings',
    section: 'settings',
    title: 'Settings',
    surfaces: ['Settings'],
    summary: 'Preferences and housekeeping open to every user: appearance and currency, sign-in methods, the trash, and a few lists the app keeps. Almost none of it has to be touched to use the app.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>Settings is a collection of both controls that affect the {APP_NAME}'s behavior
          and various utility type functions. Everything here is open to every user; what only an
          administrator may change is on the{' '}
          <HelpLink to="/help/page-administration">Administration</HelpLink> page.</p>
        <p>The following fall under utility type settings:</p>
        <ul>
          <li>
            <strong>Trash</strong> holds deleted transactions and rules until it is emptied, in
            sections that empty separately.
          </li>
          <li>
            <strong>Duplicate detection exceptions</strong> holds two lists.{' '}
            <strong>Dismissed duplicate pairs</strong> lists the pairs of transactions that have
            been marked as not duplicates. These are stored so a subsequent pass does not
            suggest them as duplicates again. Mistakes can be corrected by reopening a dismissed
            pair and then returning to the duplicate detection report to resolve it.{' '}
            <strong>Distinct account pairs</strong> lists the pairs of accounts that have been
            identified as distinct because a cross-account duplicate was surfaced and the action
            was to accept both transactions. Cross-account duplicates exist because different sources
            may identify the same account differently so what appears to be a cross-account duplicate
            may in fact be the same transaction in the same account with two different names. This
            table is about tracking the pairs which are not the same. Mistakes can be removed with
            the <strong>Forget</strong> button.
          </li>
          <li>
            <strong>Import storage</strong> clears the record each import keeps of the rows it
            refused: duplicates still flagged for review, matches against another source, the
            details needed to undo an enrichment, and rejected rows. Once cleared, those rows no
            longer appear in the duplicates view and cannot be imported anyway. Imported
            transactions are not affected.
          </li>
        </ul>
        <p>The configuration related settings are:</p>
        <ul>
          <li>
            <strong>Appearance</strong> sets the theme: Light, Dark, System, etc.
          </li>
          <li>
            <strong>Sign-in methods</strong> holds the password, passkeys and two-factor sign-in for
            the account that is signed in. It is listed only while sign-in protection is on.
            See <HelpLink to="/help/account-security">account security</HelpLink>.
          </li>
          <li>
            <strong>Currency</strong> defines the meaning of the values in the
            ledger. <HelpLink to="/help/single-currency">single-currency support</HelpLink> has details.
          </li>
          <li>
            <strong>About</strong> lists the current version, license,
            a pointer to the github repository, and the instance identifier. The instance identifier is
            stored in backups so that a restore can warn before a backup is restored to a system
            other than the one which it came from. For an administrator, About is also where the check
            for a new version is switched on or off. When it is on, {APP_NAME} periodically checks for a
            new release and adds a task when one is available.
            The task can be dismissed, and returns with the next release.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'page-administration',
    section: 'administration',
    title: 'Administration',
    surfaces: ['Administration'],
    summary: 'The settings that belong to the installation rather than to one user: how it starts, who can sign in, and backups. Only an administrator sees the page.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          Administration holds what affects the whole installation. With sign-in protection on, the
          page is listed only for users who are administrators. With it off, there are no roles and
          the page is open to anyone using the app.
        </p>
        <ul>
          <li>
            <strong>Backup / Restore</strong> makes and restores whole-database backups, optionally
            encrypted to a backup key, and is where the backup encryption keys are kept.
            See <HelpLink to="/help/data-and-backups">data on disk, and backups</HelpLink>.
          </li>
          <li>
            <strong>Error log</strong> lists the errors recorded in the "console log" file.
            A new error adds a task to the Tasks page, which clears once the error log has been
            opened.
          </li>
          <li>
            <strong>User management</strong> adds and removes the users who can sign in, sets
            whether each is an administrator, and resets a password. It is listed only while sign-in
            protection is on.
          </li>
          <li>
            <strong>Sign-in protection</strong> turns sign-in protection on and off and sets the
            password requirements. See <HelpLink to="/help/account-security">account security</HelpLink>.
          </li>
          <li>
            <strong>Network access</strong> states how the browser in use reaches {APP_NAME}: on the
            same computer, over the network with HTTPS, or over the network without it, and what each
            means for passwords, passkeys and data sources. It also states whether other devices can
            open the installation, and so who sign-in protection keeps out.
            See <HelpLink to="/help/running-a-server">running {APP_NAME} as a server</HelpLink>.
          </li>
          <li>
            <strong>Server certificate</strong> appears only on a server that other computers reach over
            HTTPS. It offers the certificate each computer installs once so its browser trusts the server,
            with the steps for Windows, Mac, Linux and a tablet, and shows the certificate's fingerprint. The same
            download is offered on the sign-in screen.
          </li>
          <li>
            <strong>Startup configuration</strong> does not allow for changing {APP_NAME}'s behavior, rather
            it shows how various settings are derived and when a default value has been
            overridden. Most of the settings here come from the optional <code>.env</code> file.{' '}
            <HelpLink to="/help/configuration">Configuration settings</HelpLink> has details.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'running-a-server',
    section: 'administration',
    title: `Running ${APP_NAME} as a server`,
    surfaces: ['Network access (Administration)', 'Set up HTTPS (Tasks)'],
    summary: `One computer runs ${APP_NAME} and the other computers in the household open it in a browser. The same download does this when started in server mode; a reverse proxy in front of it adds HTTPS, which passkeys and connecting a data source from another device both need.`,
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          A downloaded copy of {APP_NAME} normally serves only the computer it runs on. Started in{' '}
          <strong>server mode</strong>, the same copy stays running in the background, opens no browser,
          and answers to a name on the local network, <code>luma.local</code> unless changed, so every
          other computer opens the same address without knowing which machine the server is.
        </p>
        <p>
          Everyone connected sees the same data. Sign-in protection is what decides who can connect:
          with it off, anyone on the network can open the installation
          (see <HelpLink to="/help/account-security">account security</HelpLink>).
        </p>

        <HelpHeading anchor="with-https">With HTTPS</HelpHeading>
        <p>
          {APP_NAME} does not provide HTTPS itself; a small program
          called a reverse proxy sits in front of it on the same computer and does. The steps below use
          Caddy as the proxy and are for a Linux server. Run them as the user the server should run as,
          from the folder the download was unpacked into.
        </p>
        <ol>
          <li>
            Create a file named <code>.env</code> beside the program containing the
            line <code>SESSION_COOKIE_SECURE=true</code>. To answer to a name other
            than <code>luma.local</code>, add <code>MDNS_NAME=</code> followed by the name, without
            the <code>.local</code> ending.
          </li>
          <li>Install Caddy from the Linux distribution's packages.</li>
          <li>
            Give Caddy its configuration, which {APP_NAME} writes for the name and port in use:
            <pre><code>{'./luma --caddyfile | sudo tee /etc/caddy/Caddyfile\nsudo systemctl reload caddy'}</code></pre>
          </li>
          <li>
            Install {APP_NAME} as a service, so it starts whenever the computer does:
            <pre><code>{'./luma --systemd-unit | sudo tee /etc/systemd/system/luma.service\nsudo systemctl daemon-reload\nsudo systemctl enable --now luma'}</code></pre>
          </li>
          <li>
            Open <code>https://luma.local</code> from another computer. <code>journalctl -u luma</code>{' '}
            on the server shows the address if a different name was chosen.
          </li>
        </ol>
        <p>
          A firewall on the server has to allow TCP port 443 and UDP port 5353. A Mac can be the server
          as well, with the same <code>.env</code> file and Caddy configuration; starting both is then
          set up with that system's own tools.
        </p>

        <HelpHeading anchor="on-windows">On a Windows server</HelpHeading>
        <p>
          On Windows {APP_NAME} runs the proxy itself and starts when its user signs in. From the
          folder the download was unpacked into:
        </p>
        <ol>
          <li>
            Create the <code>.env</code> file as in the first step above.
          </li>
          <li>
            Download Caddy for Windows and put <code>caddy.exe</code> in the same folder
            as <code>luma.exe</code>. {APP_NAME} then starts it, configures it and stops it.
          </li>
          <li>
            In a command prompt in that folder, run this once:
            <pre><code>{'luma --start-at-sign-in'}</code></pre>
            From the next sign-in on, {APP_NAME} starts as a server with no window, and an icon in the
            notification area shows the address, opens {APP_NAME}, and stops and starts it.{' '}
            <code>luma --server --tray</code> starts it straight away,
            and <code>luma --no-start-at-sign-in</code> undoes the step. Replacing{' '}
            <code>luma.exe</code> with a newer version in the same folder, after
            choosing <strong>Exit</strong> on the icon, needs nothing further; after
            moving the folder, or unpacking a newer version into a different one, run the command
            again from there.
          </li>
          <li>
            The first time each one runs, Windows Firewall asks which networks may reach Caddy and
            which may reach {APP_NAME}. <strong>Private networks</strong> covers the other computers
            in a household. <strong>Public networks</strong> also lets anyone on a public network the
            server joins reach the sign-in page. If the other computers still cannot connect, Windows
            may be treating the home network as public; its profile is set under the network's
            properties in Windows Settings.
          </li>
        </ol>
        <p>
          The server runs while that user is signed in. If it does not start, a message names the log
          file holding the reason.
        </p>
        <p>
          To have the server start with the computer instead, with nobody signed in, use a Windows
          scheduled task in place of step 3:
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

        <HelpHeading anchor="each-device">On each computer that connects</HelpHeading>
        <p>
          The first visit shows a browser warning, because the proxy issues its own certificate and no
          computer trusts it yet. Continue past the warning once, choose{' '}
          <strong>Browser warning about this server? Install its certificate</strong> on the sign-in
          screen, and follow the steps shown for that kind of computer. After the browser is closed and reopened
          the warning is gone for good. With sign-in protection off there is no sign-in screen, and the
          same download and steps are under <strong>Administration &rarr; Server certificate</strong>.
        </p>
        <p>
          To be sure a computer received the server's own certificate, compare the fingerprint that
          computer shows for it against the one printed on the server
          by <code>./luma --certificate-fingerprint</code>. <strong>Server certificate</strong> also
          has a box that takes a fingerprint and reports whether it matches.
        </p>

        <HelpHeading anchor="without-https">Without HTTPS</HelpHeading>
        <p>
          A server can also be put on the network directly, with no proxy and no certificate to
          install: set <code>FRONTEND_HOST=0.0.0.0</code> in <code>.env</code>, skip the Caddy steps,
          and open <code>http://luma.local:8010</code>. HTTPS takes only the steps above and is how a
          server is meant to be run; going without it is the choice of whoever runs the server. What
          it costs:
        </p>
        <ul>
          <li>
            Everything crosses the network unencrypted, sign-in passwords and the vault passphrase
            included. A vault passphrase read off the network opens the data provider credentials in
            any copy of the database or of a credentials backup.
          </li>
          <li>Passkeys are unavailable.</li>
          <li>
            A data source can be connected, and a provider's secret saved or shown, only from a
            browser on the server itself. Syncing and everything else works from any computer.
          </li>
        </ul>
        <p>
          <strong>Administration &rarr; Network access</strong> states which of these connections the
          browser in use has, and whether other devices can open the installation at all, which is
          what decides who sign-in protection keeps out.
        </p>

        <HelpHeading anchor="updating">Updating the server</HelpHeading>
        <p>
          Stop the service, unpack the new download in the same place as the last one, and start it
          again. The <code>.env</code> file and the data are not part of the download and are left as
          they were.
        </p>
        <pre><code>{'sudo systemctl stop luma\ntar -xzf luma-<version>-linux-x64.tar.gz\nsudo systemctl start luma'}</code></pre>
      </>
    ),
  },
  {
    id: 'configuration',
    section: 'administration',
    title: 'Configuration settings',
    surfaces: ['Startup configuration (Administration)'],
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
          transactions in a foreign one are dropped the same way. A CSV file is taken at face value: its
          amounts are read as plain numbers, so a file holding another currency imports figures that do not
          mean what the rest of the ledger means.
        </p>
      </>
    ),
  },
  {
    id: 'data-and-backups',
    section: 'general-concepts',
    title: 'Data on disk, and backups',
    surfaces: ['Backup / Restore (Administration)'],
    summary: `Transactions live in a plain-text database on a presumably private system. Handle the file carefully if the data is considered sensitive.`,
    body: () => (
      <>
        <p>
          There are two SQLite databases which store almost all of the data for {APP_NAME}.
          Attachments are stored outside the databases in a documents directory next
          to the data file. The console log sits beside it.
        </p>
        <p>
          Accounts, transactions, categories, tags are all stored in{' '}
          <strong>plain text</strong> in the data.db file. Application settings, user
          profiles, and other non-transaction related data is stored in the control.db file.
          Secrets and credentials for accessing <HelpLink to="/help/data-providers">data
            providers</HelpLink>{' '} are encrypted and are spread across both files.
        </p><p>
          Protection for the transaction data comes from the computer's security (disk encryption,
          OS login, who can physically reach the machine, who has access to the network), not from {APP_NAME}.
          A sign-in password is available to restrict <em>network</em> access to the app.
        </p>
        <HelpHeading anchor="backups">Backups</HelpHeading>
        <p>
          Backups are made and restored by an administrator, under <strong>Backup / Restore</strong> on
          the <HelpLink to="/help/page-administration">Administration</HelpLink> page. There are two,
          and each holds what the other does not.
        </p>
        <ul>
          <li>
            The <strong>data backup</strong> holds the ledger: categories, rules, owners, accounts and
            transactions. For each data connection it holds everything except the credential: that the
            connection exists, its account mapping and how far it had synced. If the transaction data
            is considered sensitive, {APP_NAME} can generate key pairs to build strongly encrypted
            backup files.
          </li>
          <li>
            The <strong>credentials backup</strong> holds the stored credential for each connection and
            the provider secrets entered with <strong>Configure</strong>, encrypted as they are in
            the <HelpLink to="/help/credential-vault">vault</HelpLink>. It needs no further encryption.
            To open them elsewhere it also carries the unlock methods of the user who generated the
            file: their vault passphrase, their recovery code and their passkeys. Other users&apos;
            unlock methods are not in it. The file is only as hard to break into as the weakest
            method in it, which is why it cannot be generated while that user&apos;s passphrase fails
            the current strength rule.
          </li>
        </ul>

        <HelpHeading anchor="credentials-restore-passphrase">What a credentials restore asks for</HelpHeading>
        <div className="help-table-scroll">
          <table>
            <thead>
              <tr><th>Restoring to</th><th>Asked for</th></tr>
            </thead>
            <tbody>
              <tr>
                <td>The installation that made the backup</td>
                <td>Nothing, with the vault unlocked. The backup of any user restores, and a passphrase
                  changed since the backup makes no difference.</td>
              </tr>
              <tr>
                <td>The same installation, after <strong>Replace vault key</strong> or a rebuilt vault</td>
                <td>One of the generating user&apos;s unlock methods as it was at the time: the
                  passphrase, the recovery code, or a passkey.</td>
              </tr>
              <tr>
                <td>A different installation</td>
                <td>The same. No other user&apos;s passphrase opens the file. A passkey is offered only
                  where the new installation is reached at the same name the passkey was added at (for
                  example <code>luma.local</code>), over HTTPS. The vault on the new installation has to
                  exist and be unlocked, under whatever passphrase was set there.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          A passphrase or recovery code that has been replaced is therefore worth keeping, with the date
          it was replaced, for as long as a backup made under it might be restored somewhere else. The
          restore names the date the file&apos;s recovery code was issued, to tell which kept code opens it.
        </p>

        <HelpHeading anchor="restoring-both">Restoring data and credentials</HelpHeading>
        <p>
          The two files restore separately, in either order, and neither undoes the other.
        </p>
        <ul>
          <li>
            A data restore replaces the ledger and never removes a credential. A connection that is
            both in the backup and on the installation keeps its credential and goes back to the sync
            position it had when the backup was made, so the next sync fetches what has arrived since.
          </li>
          <li>
            A connection in the data backup that the installation does not have is created without a
            credential, waiting to be reconnected. Its accounts and mapping are kept, and a
            credentials restore afterwards fills the credential in.
          </li>
          <li>
            A connection on the installation that the data backup does not mention keeps its
            credential and loses its account list. <strong>Refresh accounts</strong> in the
            connection&apos;s menu fetches the list again, and the next sync then reads its history
            again. The same applies to a credentials backup restored with no data backup.
          </li>
          <li>
            A credentials restore replaces the credentials stored on the installation and leaves
            accounts and transactions alone.
          </li>
        </ul>
        <p>
          To move to a new machine: restore the data backup, set a vault passphrase on the Connections
          tab, then restore the credentials backup.
        </p>
        <p>
          A credentials backup made before <strong>Respond to an exposure</strong> was used
          in <HelpLink to="/help/vault-settings#exposure">Vault settings</HelpLink> holds credentials
          the providers no longer accept.
        </p>

        <HelpHeading anchor="exposed-files">If the database files are exposed</HelpHeading>
        <p>
          The transactions in the copy are exposed, and where there are data connections the
          credentials in it are retired at their providers, even though they are encrypted.{' '}
          <HelpLink to="/help/copied-database">If the database or a backup is copied</HelpLink> has the
          steps.
        </p>
      </>
    ),
  },
  {
    id: 'copied-database',
    section: 'general-concepts',
    title: 'If the database or a backup is copied',
    surfaces: ['Vault settings (Respond to an exposure)'],
    summary: 'The transactions in a copied database or unencrypted backup are exposed for good. The provider credentials in it are encrypted, and are replaced or revoked at each provider so the copy cannot use them.',
    body: () => (
      <>
        <p>*needs review*</p>
        <p>
          A copy of the database files, or of a data backup that was not encrypted, holds the
          transactions in plain text. Nothing done afterwards changes what is in a file someone
          already has.
        </p>
        <p>
          The data provider credentials in the copy are encrypted, and what protects them is how well
          the vault passphrase stands up to guessing, which can go on against a copy without limit. So
          they are treated as reachable, and retired at each provider. That is the one step that
          reaches a credential already in the copy.
        </p>

        <HelpHeading anchor="steps">The steps, in order</HelpHeading>
        <ol>
          <li>
            Open <HelpLink to="/help/vault-settings">Vault settings</HelpLink> from the strip at the
            top of the Connections tab, and under <strong>Respond to an exposure</strong>{' '}
            choose <strong>Replace connection credentials&hellip;</strong>. Each provider that supports
            it issues a new credential, so the copied one stops working and the connection keeps
            syncing.
          </li>
          <li>
            Work through what is listed afterwards. A connection whose provider could not replace its
            credential is revoked at the provider and then reconnected. A provider secret entered
            with <strong>Configure</strong> is rotated at the provider, the new one is entered
            with <strong>Configure</strong>, and the old one is then deleted at the provider, since it
            can keep working until it is.
          </li>
          <li>
            Change the vault passphrase, under <strong>Unlock methods</strong>.
          </li>
          <li>
            Choose <strong>Replace vault key&hellip;</strong>.
          </li>
          <li>
            Make a new credentials <HelpLink to="/help/data-and-backups#backups">backup</HelpLink>. One
            made earlier holds the replaced credentials, which the providers no longer accept.
          </li>
        </ol>
        <p>
          Steps 3 and 4 protect what is encrypted from then on, the new credentials included. A
          passphrase worked out from the copy would otherwise still open the vault, and the key it
          reaches would still decrypt what the vault holds. Each step retires one of the two, so both
          are needed. This is done once for an exposure and is not a routine to repeat.
        </p>
        <p>
          Any other copy of the database, such as a second installation or one restored from a backup,
          stops syncing the connections whose credentials were replaced. A connection card
          reports <strong>reconnect needed</strong> when its provider no longer accepts the stored
          credential.
        </p>
      </>
    ),
  },
  {
    id: 'account-security',
    section: 'general-concepts',
    title: 'Account security: password, passkeys and two-factor',
    surfaces: ['Sign-in protection (Administration)', 'Sign-in methods (Settings)'],
    summary: `Sign-in protection is a network perimeter: it keeps people who aren't users out. It is not disk encryption, and everyone signed in shares the same data. A passkey signs in without a typed password and without a two-factor code; two-factor adds a code at sign-in and is optional.`,
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
        <p>*needs review*</p>
        <p>
          The switch under <strong>Sign-in protection</strong> on the{' '}
          <HelpLink to="/help/page-administration">Administration</HelpLink> page turns sign-in
          protection on and off.
          Turning it on sets a password for the administrator's own account; any other users choose
          theirs at their next sign-in. Turning it off takes an administrator and removes the
          password check for everyone, but keeps every account and password, so turning it back on
          later needs nothing re-entered.
        </p>
        <p>
          <strong>Password policy</strong> sets how strong account passwords must be. It applies to
          all users, and it can be tightened or relaxed at any time.
        </p>
        <p>
          Each user's own password is changed under <strong>Sign-in methods</strong> on the{' '}
          <HelpLink to="/help/page-settings">Settings</HelpLink> page. The current password is
          required, and the change signs the account out of every other browser.
        </p>
        <p>*needs review*</p>
        <p>
          <strong>Passkeys</strong> sign in with a fingerprint, face or device PIN instead of a typed
          password. Each device gets its own passkey, added under <strong>Sign-in methods</strong> while
          signed in. The account password keeps working and is still what signs in on a connection
          that cannot run a passkey &mdash; passkeys need an HTTPS connection to a named host, so an
          instance reached by IP address cannot use them at all.
        </p>
        <p>
          A passkey is <em>not</em> a vault passkey. The vault's passkeys unlock stored data
          connection credentials (see{' '}
          <HelpLink to="/help/vault-settings">Vault settings</HelpLink>); these sign in to the
          application. Adding one here grants nothing in the vault, and an account may hold both.
        </p>
        <p>
          <strong>Two-factor (an authenticator app)</strong> adds a one-time code after the password.
          When it is on, the code is requested <strong>every fresh sign-in</strong> &mdash; a browser
          with an active session is not asked again until that session ends, but there is no "trust
          this device" that skips the code on a new sign-in. A passkey is the exception: the device
          already checks a fingerprint, face or PIN before it will sign anything, so a passkey sign-in
          completes without a code. If authenticator access is lost, the{' '}
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
      </>
    ),
  },
]

export const HELP_TOPICS_BY_ID = Object.fromEntries(HELP_TOPICS.map(t => [t.id, t]))
