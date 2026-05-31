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
import globals from 'globals'

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

      // The headline rules.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // Catches non-component exports from .jsx modules that would break Vite HMR.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // Transaction writes that change derived counts must route through `txnMutations`
      // (src/lib/txnMutations.js) so the Tasks badge / future invalidations fire automatically.
      // Calling these `api.*` methods directly is how the badge kept going stale; the wrapper is
      // the only sanctioned caller (it overrides this rule for itself below).
      'no-restricted-properties': ['error',
        { object: 'api', property: 'overrideCategory', message: 'Use txnMutations.setCategory so derived counts (Tasks badge, etc.) get invalidated.' },
        { object: 'api', property: 'clearOverride', message: 'Use txnMutations.uncategorize so derived counts get invalidated.' },
        { object: 'api', property: 'applyRule', message: 'Use txnMutations.applyRule so derived counts get invalidated.' },
        { object: 'api', property: 'trashTransaction', message: 'Use txnMutations.trashTransaction so derived counts get invalidated.' },
        { object: 'api', property: 'restoreTransaction', message: 'Use txnMutations.restoreTransaction so derived counts get invalidated.' },
      ],
    },
  },
  {
    // The mutation layer is the one sanctioned place that calls the wrapped api.* writes directly.
    files: ['src/lib/txnMutations.js'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    // Build/tool scripts run in Node, not the browser.
    files: ['scripts/**/*.js', 'vite.config.js', 'playwright.config.js', 'eslint.config.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
]
