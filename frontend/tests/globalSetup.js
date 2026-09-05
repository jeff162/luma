// E2E seed and sign-in. Runs once, before any spec.
//
// Two jobs, and the second is the one that used to be missing. A pristine stack boots with no
// identities, so the app shows the "Getting Started" gate and every API call answers 401 — including
// the demo-data load itself, which is scoped to the *current* identity. So this establishes a session
// first, then seeds through it.
//
// **The session is then written to disk for the specs to adopt** (`use.storageState`). That file is
// read both when a browser context opens and by the `request` fixture, which is what makes an API call
// from a spec as authenticated as a click — they are separate contexts and do not otherwise share a
// cookie. Without it a spec's `request` calls silently 401, and a helper that shrugs at a failed
// response turns that into a UI timeout thirty seconds later, nowhere near the cause.
//
// Seeds through the frontend's /api proxy (the same path the app uses) once both managed servers are
// up. Against an external stack (PLAYWRIGHT_BASE_URL) it signs in but seeds nothing: that caller owns
// its own data, and creating an identity there is not this script's business either.

import fs from 'node:fs/promises'
import path from 'node:path'

import { request } from '@playwright/test'

import { AUTH_STATE_PATH } from './authState.js'

async function post(ctx, url, body) {
  const resp = await ctx.post(url, body === undefined ? undefined : { data: body })
  if (!resp.ok()) {
    throw new Error(`globalSetup: ${url} failed (${resp.status()}): ${await resp.text()}`)
  }
  return resp.json()
}

export default async function globalSetup(config) {
  // Read from the resolved project rather than assumed: the smoke config runs on its own ports, and a
  // hard-coded default here would quietly sign in to — and seed — the wrong stack.
  const baseURL = config.projects?.[0]?.use?.baseURL
  if (!baseURL) {
    throw new Error('globalSetup: no baseURL on the resolved project; nothing to seed')
  }
  const external = !!process.env.PLAYWRIGHT_BASE_URL

  const ctx = await request.newContext({ baseURL })
  try {
    const listing = await ctx.get('/api/auth/identities')
    if (!listing.ok()) {
      throw new Error(`globalSetup: could not list identities (${listing.status()}): ${await listing.text()}`)
    }
    const existing = (await listing.json()).identities || []

    let identity = existing[0]
    if (!identity) {
      if (external) {
        throw new Error(
          'globalSetup: the external stack has no identity to sign in as, and creating one there is '
          + 'not this script\'s call. Create one in the app first.',
        )
      }
      identity = (await post(ctx, '/api/auth/identities', { name: 'Demo' })).identity
    }

    // Creating an identity does not sign anyone in; this is what establishes the session, and the
    // context holds the cookie from here on.
    await post(ctx, '/api/auth/select-identity', { user_id: identity.id })

    if (!external) {
      await post(ctx, '/api/auth/demo-data')
    }

    await fs.mkdir(path.dirname(AUTH_STATE_PATH), { recursive: true })
    await ctx.storageState({ path: AUTH_STATE_PATH })
  } finally {
    await ctx.dispose()
  }
}
