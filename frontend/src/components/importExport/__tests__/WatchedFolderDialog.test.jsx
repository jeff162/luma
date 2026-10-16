// @vitest-environment jsdom

// Choosing a watched folder. The claim the design rests on is that there is **one** path: the field is
// what the picker lists, and navigating writes back into it. An earlier version kept the live path
// inside the picker and left the field behind, which is what made the field read as inert. Paths and
// folder names here are invented.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({
  browseServerDirectories: vi.fn(),
  updateImportProfileWatch: vi.fn(),
}))
vi.mock('../../../lib/api.js', () => ({ api }))

const WatchedFolderDialog = (await import('../WatchedFolderDialog.jsx')).default

const ROOTS = [{ label: 'Home', path: '/home/sam' }, { label: 'Filesystem root', path: '/' }]

// The server's folders, as the endpoint would answer for each path.
const TREE = {
  '/home/sam': { entries: [{ name: 'exports', path: '/home/sam/exports', hidden: false },
                           { name: '.cache', path: '/home/sam/.cache', hidden: true }],
                 files: [], file_count: 0, parent: '/home' },
  '/home/sam/exports': { entries: [],
                         files: [{ name: 'january.csv' }, { name: 'february.csv' }, { name: 'march.csv' }],
                         file_count: 3, parent: '/home/sam' },
  // A folder with neither subfolders nor anything importable — the only case left that says so.
  '/home/sam/empty': { entries: [], files: [], file_count: 0, parent: '/home/sam' },
}

function mockBrowse() {
  api.browseServerDirectories.mockImplementation(async (path) => {
    const node = TREE[path] || { entries: [], files: [], file_count: 0, parent: null }
    return { path: path || null, roots: ROOTS, notice: null, truncated: false, ...node }
  })
}

const profile = (overrides = {}) => ({ id: 'src-1', name: 'Harborline', watch_dir: '', watch_enabled: false,
                                       watch_purge_mode: 'never', watch_purge_days: 30, ...overrides })

function renderDialog(props = {}) {
  mockBrowse()
  const onClose = vi.fn()
  render(<WatchedFolderDialog profile={profile()} canEdit onClose={onClose} onSaved={vi.fn()} {...props} />)
  return { onClose }
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

const folderField = () => screen.getByLabelText('Watched folder path')

describe('WatchedFolderDialog folder picker', () => {
  it('writes the folder it navigates into back to the path field', async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByRole('button', { name: /Browse/ }))
    await user.click(await screen.findByRole('button', { name: 'Home' }))
    expect(folderField().value).toBe('/home/sam')

    await user.click(await screen.findByRole('button', { name: /exports/ }))
    expect(folderField().value).toBe('/home/sam/exports')
  })

  it('lists the files the folder would import, which is what answers "is this the one"', async () => {
    // The names settle it in a way a path cannot. They are not buttons: a folder is picked, never a
    // file, so there is nothing to focus and nothing that looks clickable and then is not.
    const user = userEvent.setup()
    renderDialog({ profile: profile({ watch_dir: '/home/sam/exports' }) })
    await user.click(screen.getByRole('button', { name: /Browse/ }))
    expect(await screen.findByText('january.csv')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'january.csv' })).toBeNull()
    // The count is still carried, because the files sort under the folders and can fall below the fold.
    expect(screen.getByText(/3 importable files in this folder/)).toBeTruthy()
  })

  it('puts back the path it started from when the browse is abandoned', async () => {
    // Navigating edits the field as it goes, so Cancel has to restore rather than leave the walk's end.
    const user = userEvent.setup()
    renderDialog({ profile: profile({ watch_dir: '/home/sam/exports' }) })
    await user.click(screen.getByRole('button', { name: /Browse/ }))
    await user.click(await screen.findByRole('button', { name: 'Home' }))
    expect(folderField().value).toBe('/home/sam')

    await user.click(screen.getByRole('button', { name: 'Cancel choosing a folder' }))
    expect(folderField().value).toBe('/home/sam/exports')
  })

  it('keeps what was navigated to when the browse is finished', async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByRole('button', { name: /Browse/ }))
    await user.click(await screen.findByRole('button', { name: 'Home' }))
    await user.click(screen.getByRole('button', { name: 'Done choosing a folder' }))
    expect(folderField().value).toBe('/home/sam')
  })

  it('lists what is typed into the field, so the field and the picker are one path', async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByRole('button', { name: /Browse/ }))
    await user.type(folderField(), '/home/sam')
    await waitFor(() => expect(screen.getByRole('button', { name: /exports/ })).toBeTruthy())
  })

  it('holds the list area open before a path is picked, so the first click does not grow the dialog', async () => {
    // The height is reserved either way; only the border and fill come and go, because a bordered box
    // holding one line of text is indistinguishable from the text field above it.
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByRole('button', { name: /Browse/ }))
    const empty = await screen.findByText(/Pick a starting place/)
    const region = empty.closest('div[style*="height"]')
    expect(region).toBeTruthy()
    expect(screen.queryByRole('button', { name: /exports/ })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Home' }))
    await screen.findByRole('button', { name: /exports/ })
    // Same region, same reserved height — it gained a border and a listing, not a size.
    expect(screen.queryByText(/Pick a starting place/)).toBeNull()
  })

  it('says a folder holding neither folders nor files is empty rather than leaving it to guesswork', async () => {
    // A bare region after a spinner reads equally as "still loading" and "failed". A folder with files
    // but no subfolders is *not* this case — it shows the files.
    const user = userEvent.setup()
    renderDialog({ profile: profile({ watch_dir: '/home/sam/empty' }) })
    await user.click(screen.getByRole('button', { name: /Browse/ }))
    expect(await screen.findByText('empty')).toBeTruthy()
  })

  it('holds a hidden folder back behind a count rather than listing or losing it', async () => {
    const user = userEvent.setup()
    renderDialog({ profile: profile({ watch_dir: '/home/sam' }) })
    await user.click(screen.getByRole('button', { name: /Browse/ }))
    expect(await screen.findByRole('button', { name: /exports/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /\.cache/ })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Show 1 hidden' }))
    expect(screen.getByRole('button', { name: /\.cache/ })).toBeTruthy()
  })
})
