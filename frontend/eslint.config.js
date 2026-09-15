// Flat-config ESLint setup (eslint 9+). The previous .eslintrc was never run by any
// npm script; `lint:frontend` now invokes eslint here in addition to the custom
// comment-quality checker (scripts/check-comments.js).
//
// Rule choices kept narrow on purpose. The two headline plugins are react-hooks
// (catches stale-closure / missing-dep bugs in useEffect, useMemo, etc. — the very bug
// that hid the Tasks nav badge) and react-refresh (warns when a non-component export
// in a .jsx module would break Vite HMR).

import js from '@eslint/js'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import jsdoc from 'eslint-plugin-jsdoc'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import globals from 'globals'

// Transaction writes that change derived counts must route through `txnMutations` so the Tasks
// badge / future invalidations fire automatically — calling these `api.*` methods directly is how
// the badge kept going stale.
const txnMutationRestrictions = [
  { object: 'api', property: 'overrideCategory', message: 'Use txnMutations.setCategory so derived counts (Tasks badge, etc.) get invalidated.' },
  { object: 'api', property: 'clearOverride', message: 'Use txnMutations.uncategorize so derived counts get invalidated.' },
  { object: 'api', property: 'applyRule', message: 'Use txnMutations.applyRule so derived counts get invalidated.' },
  { object: 'api', property: 'widenRuleRange', message: 'Use txnMutations.widenRuleRange so derived counts get invalidated.' },
  { object: 'api', property: 'trashTransaction', message: 'Use txnMutations.trashTransaction so derived counts get invalidated.' },
  { object: 'api', property: 'restoreTransaction', message: 'Use txnMutations.restoreTransaction so derived counts get invalidated.' },
  { object: 'api', property: 'acceptRuleSuggestions', message: 'Use txnMutations.acceptRuleSuggestions so derived counts get invalidated.' },
  { object: 'api', property: 'setRuleSuggestionStatus', message: 'Use txnMutations.setRuleSuggestionStatus so derived counts get invalidated.' },
  { object: 'api', property: 'resolveRuleSuggestionConflictSet', message: 'Use txnMutations.resolveRuleSuggestionConflictSet so derived counts get invalidated.' },
  { object: 'api', property: 'undoRuleSuggestionAction', message: 'Use txnMutations.undoRuleSuggestionAction so derived counts get invalidated.' },
]

// User preferences have a single public pathway: useUserPreference / setPreference from
// UserPreferencesContext, which keeps the in-memory store, backend, and defaults in sync. Calling
// the raw `api.*UserPreference*` methods from feature code lets the in-memory store drift from
// what's persisted (a collapsed section silently re-opening on the next visit, etc.). The only
// sanctioned direct callers are the context itself and the app shell (App.jsx bootstraps the
// startup route above the provider; Settings runs the destructive reset) — overridden below.
const preferencePersistenceRestrictions = [
  { object: 'api', property: 'getUserPreferences', message: 'Read preferences via useUserPreference / UserPreferencesContext, not api.getUserPreferences directly.' },
  { object: 'api', property: 'saveUserPreference', message: 'Persist via setPreference / useUserPreference (UserPreferencesContext) so the in-memory store and backend stay in sync.' },
  { object: 'api', property: 'clearUserPreferences', message: 'Clear preferences through UserPreferencesContext, not api.clearUserPreferences directly.' },
]

// The shared date filter must be read through the getters, not the raw field: getDate() (default-aware
// — what almost everything wants) or getRawDate() (explicit-only — the rare bypass, e.g. the
// Transactions ledger). Reading `filters.date` directly silently skips the page-default logic. The
// files that legitimately read the explicit value — the FilterContext that defines it, the FilterBar
// date-picker UI, the Dashboard trend (deliberately keyed on the explicit pick, not the default), and
// ExportTab (its own nested provider with no default) — are allowlisted in the overrides below.
const filterDateRestrictions = [
  { object: 'filters', property: 'date', message: 'Read the period via getDate() (default-aware) or getRawDate() (explicit-only) from useFilters — reading filters.date directly bypasses the page-default logic.' },
]

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'playwright-report/**', 'test-results/**'],
  },
  js.configs.recommended,
  react.configs.flat.recommended,
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.browser,
        ...globals.node,
        // Vite `define` replacement injected at build time (see frontend/vite.config.js).
        __APP_VERSION__: 'readonly',
      },
    },
    settings: { react: { version: 'detect' } },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'jsx-a11y': jsxA11y,
      jsdoc,
    },
    rules: {
      // Kept from the previous .eslintrc so we don't lose the original intent.
      'no-warning-comments': ['warn', { terms: ['todo', 'fixme'], location: 'anywhere' }],
      'spaced-comment': ['warn', 'always', { markers: ['/'], exceptions: ['-'] }],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'jsdoc/require-description': 'off',
      'jsdoc/check-tag-names': 'off',

      // The new JSX transform makes the React import unnecessary; prop-types isn't used here.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',

      // Empty `catch {}` is the project's idiom for browser-storage / JSON-parse calls
      // whose failure mode (private-mode storage, missing key, malformed JSON) we
      // intentionally don't care about; the surrounding code handles the absent value.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // The headline rules. `exhaustive-deps` is an error rather than a warn because the tree is
      // currently clean of it — promoting a rule with nothing left to clear costs nothing and turns
      // it into a real gate, which a warn in a zero-warning tree is not (the next stale-closure bug
      // would land as noise nobody is watching for).
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',

      // A component defined inside another component's render is a new type every render, so React
      // unmounts the subtree and throws away its DOM and state. `allowAsProps` is on because the
      // render-prop form is a library API rather than the mistake: Recharts' Sankey takes `link` /
      // `node` as functions returning an element, and rewriting those to satisfy the rule would be
      // restructuring correct markup. Clean at zero hits with that option.
      'react/no-unstable-nested-components': ['error', { allowAsProps: true }],

      // Catches non-component exports from .jsx modules that would break Vite HMR.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // Measured and left off deliberately, both pure-formatting rules whose hits are all harmless:
      // `jsx-no-useless-fragment` (4 hits) flags fragments that wrap a single child, and its autofix
      // dedents the parent without reindenting the children — so taking it means either misleading
      // markup or a ~150-line reindent of files nothing else in the change touches. `no-array-index-key`
      // (31 hits) is a genuine bug class only in reorderable lists; the rest are static renders where
      // the index is a stable key, so it needs per-site judgment rather than a sweep.
      'react/jsx-no-useless-fragment': 'off',
      'react/no-array-index-key': 'off',

      // Accessibility (label association only — not the full jsx-a11y recommended set).
      // `control-has-associated-label` is OFF on purpose: this codebase uses placeholder-only inputs
      // widely, which it counts as unlabeled (101 hits, re-measured — it was 89 when this was written,
      // so it grows with the UI) while the browser counts the placeholder as the accessible name
      // (≈1 hit) — so it floods and can't isolate the real runtime issue. Revisit
      // only as part of a dedicated a11y sweep. `label-has-associated-control` catches the smaller,
      // genuinely-broken class (a <label> wired to no control / with no text) and is kept as a warn.
      // The autofill-oriented "needs id/name" console warnings are not a11y rules; left for later.
      'jsx-a11y/control-has-associated-label': 'off',
      // depth 4 (default 2) so labels that wrap their control with the visible text a couple <div>s
      // deep (e.g. the delete-category radio rows) are correctly seen as labelled, not false-flagged.
      'jsx-a11y/label-has-associated-control': ['error', { depth: 4 }],

      // See the txnMutation / preference / filter-date restriction lists defined above this config.
      'no-restricted-properties': ['error', ...txnMutationRestrictions, ...preferencePersistenceRestrictions, ...filterDateRestrictions],
    },
  },
  {
    // The mutation layer is the one sanctioned place that calls the wrapped txn api.* writes directly.
    files: ['src/lib/txnMutations.js'],
    rules: { 'no-restricted-properties': ['error', ...preferencePersistenceRestrictions, ...filterDateRestrictions] },
  },
  {
    // The preferences context owns persistence; the app shell (App.jsx) bootstraps the startup route
    // above the provider and Settings runs the destructive reset. These keep the txn + filter-date guards.
    files: ['src/lib/UserPreferencesContext.jsx', 'src/App.jsx', 'src/pages/Settings.jsx'],
    rules: { 'no-restricted-properties': ['error', ...txnMutationRestrictions, ...filterDateRestrictions] },
  },
  {
    // Files that legitimately read the *explicit* date field: the context that defines it, the date-picker
    // UI, the Dashboard trend (keyed on the explicit pick, not the default), and ExportTab's nested
    // provider. They keep the txn + preference guards; only the filters.date guard is lifted here.
    files: [
      'src/lib/FilterContext.jsx',
      'src/components/FilterBar.jsx',
      'src/pages/Dashboard.jsx',
      'src/components/importExport/ExportTab.jsx',
    ],
    rules: { 'no-restricted-properties': ['error', ...txnMutationRestrictions, ...preferencePersistenceRestrictions] },
  },
  {
    // The help registry is prose, and `no-unescaped-entities` objects only to the straight ASCII
    // forms -- `don't`, `"quoted"` -- which are the ones a keyboard produces. Left on, it pushes
    // every apostrophe in the copy toward `&rsquo;`, which reads worse in source, and decodes only
    // in JSX text: the same entity pasted into a `summary:` string renders as its literal
    // characters. Off here, the topics are written with the punctuation they are typed with. This
    // lifts nothing else -- `>` and `}` in JSX text stay parse errors, which no rule setting
    // changes.
    files: ['src/help/**'],
    rules: { 'react/no-unescaped-entities': 'off' },
  },
  {
    // Build/tool scripts run in Node, not the browser.
    files: ['scripts/**/*.js', 'vite.config.js', 'playwright.config.js', 'eslint.config.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
]
