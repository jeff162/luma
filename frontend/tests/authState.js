import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Where the seeded session is parked between global setup and the specs.
//
// It exists as a file because that is the only channel Playwright offers: `use.storageState` is read
// per browser context *and* by the `request` fixture, which is the whole point — an API call made from
// a spec has to be as authenticated as a click is. Resolved from this module's own location rather than
// the working directory, since the two configs are launched from different places.
const here = path.dirname(fileURLToPath(import.meta.url))

export const AUTH_STATE_PATH = path.join(here, '.auth', 'state.json')
