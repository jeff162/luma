// Runs before every test file, in both the default Node environment and the jsdom opt-in.
//
// React 18 refuses to treat a test as an "act environment" unless this global says so, and warns on
// every `act()` call when it is missing. `@testing-library/react` sets it around its own helpers, so
// the warning only reached the files that import `act` from `react` directly — which is a distinction
// nobody should have to know. Setting it once here covers both spellings, and keeps a genuine warning
// from being lost in a wall of this one.
globalThis.IS_REACT_ACT_ENVIRONMENT = true
