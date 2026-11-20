# Lint on ESLint 10

## What it is

Move `eslint` and `@eslint/js` from 9 to 10, so the frontend lint stays on a supported major. Nothing
users see changes.

**Where it stands:** parked on two plugins releasing ESLint 10 support.

- **eslint-plugin-react** — 7.37.5 crashes while loading its rules under ESLint 10
  (`contextOrFilename.getFilename is not a function`, jsx-eslint/eslint-plugin-react#4018). The fix is
  merged but unreleased; #4027 tracks the rest.
- **eslint-plugin-jsx-a11y** — 6.10.2 declares support only up to ESLint 9, and
  jsx-eslint/eslint-plugin-jsx-a11y#1075 is open.

The other plugins (react-hooks, jsdoc, react-refresh) already accept ESLint 10.

## Checking whether it is unblocked

```sh
npm view eslint-plugin-react peerDependencies.eslint
npm view eslint-plugin-jsx-a11y peerDependencies.eslint
```

Unblocked when both ranges include `^10`. Forcing the install past them with npm `overrides` is not a way
round: it installs a plugin version that crashes, so the lint gate fails outright.

## When it is

Update the two plugins, then `eslint` and `@eslint/js` to `^10`. Run `npm run lint` from `frontend/` and
fix what the new defaults flag. Then delete this file and its line in the index.
