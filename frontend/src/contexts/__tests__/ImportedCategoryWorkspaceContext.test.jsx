// @vitest-environment jsdom

// The shared imported-category draft, where two windows or two members can be arranging the same tree.
//
// Saving used to be fire-and-forget: every edit sent its own request, the last to arrive won, and a failure
// was swallowed. These pin what replaced it — saves run one at a time and coalesce, each names the revision
// it was edited from, a refusal stops saving and asks which arrangement to keep, and any other failure is
// shown. Apply is one server call now, and a failed one reloads the tree it was built from.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = {
  getCategoryWorkspaceDraft: vi.fn(),
  saveCategoryWorkspaceDraft: vi.fn(),
  getCategories: vi.fn(),
  applyImportedCategoryWorkspace: vi.fn(),
  getCategoryDeletePreview: vi.fn(),
  deleteCategory: vi.fn(),
}

vi.mock('../../lib/api.js', () => ({ api }))
// The workspace itself is not under test, and it saves on mount; standing it in keeps the save counts about
// the provider.
vi.mock('../../components/CategoryImportWorkspace.jsx', () => ({ default: () => null }))

const {
  ImportedCategoryWorkspaceProvider,
  ImportedCategoryWorkspaceRenderer,
  useImportedCategoryWorkspace,
} = await import('../ImportedCategoryWorkspaceContext.jsx')

const draftOf = label => ({ snapshot: { tree: { income: [], expense: [] }, sourceOrder: [label], setAsideOrder: [] } })

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

let ctx
function Probe() {
  ctx = useImportedCategoryWorkspace()
  return null
}

async function renderProvider({ revision = 3 } = {}) {
  api.getCategoryWorkspaceDraft.mockResolvedValue({ draft: null, revision })
  api.getCategories.mockResolvedValue([])
  render(
    <ImportedCategoryWorkspaceProvider>
      <Probe />
      <ImportedCategoryWorkspaceRenderer />
    </ImportedCategoryWorkspaceProvider>,
  )
  await waitFor(() => expect(api.getCategoryWorkspaceDraft).toHaveBeenCalled())
  // Let the load settle so the revision it returned is the one the first save is based on.
  await act(async () => {})
}

function conflictError(draft, revision) {
  return Object.assign(new Error('The imported-category draft was changed somewhere else.'), {
    status: 409,
    detail: { code: 'draft_conflict', draft, revision },
  })
}

afterEach(() => {
  cleanup()
  Object.values(api).forEach(fn => fn.mockReset())
  ctx = null
})

describe('saving the shared draft', () => {
  it('sends one save at a time, based on the revision it read, and coalesces edits made meanwhile', async () => {
    await renderProvider({ revision: 3 })
    const first = deferred()
    api.saveCategoryWorkspaceDraft.mockReturnValueOnce(first.promise).mockResolvedValue({ revision: 5 })

    act(() => { ctx.setDraft(draftOf('Coffee')) })
    act(() => { ctx.setDraft(draftOf('Tea')) })
    act(() => { ctx.setDraft(draftOf('Tolls')) })
    expect(api.saveCategoryWorkspaceDraft).toHaveBeenCalledTimes(1)
    expect(api.saveCategoryWorkspaceDraft).toHaveBeenLastCalledWith(draftOf('Coffee'), 3)

    await act(async () => { first.resolve({ revision: 4 }) })
    await waitFor(() => expect(api.saveCategoryWorkspaceDraft).toHaveBeenCalledTimes(2))
    // The edit in between is never sent: only the latest arrangement matters.
    expect(api.saveCategoryWorkspaceDraft).toHaveBeenLastCalledWith(draftOf('Tolls'), 4)
  })

  it('stops at a refused save and keeps this arrangement only when asked to', async () => {
    const user = userEvent.setup()
    await renderProvider({ revision: 3 })
    api.saveCategoryWorkspaceDraft
      .mockRejectedValueOnce(conflictError(draftOf('Theirs'), 7))
      .mockResolvedValue({ revision: 8 })

    await act(async () => { ctx.setDraft(draftOf('Coffee')) })
    await screen.findByText('The category draft changed somewhere else')

    // Further edits wait for the decision instead of being refused one after another.
    await act(async () => { ctx.setDraft(draftOf('Tea')) })
    expect(api.saveCategoryWorkspaceDraft).toHaveBeenCalledTimes(1)

    await user.click(screen.getByText('Keep this arrangement'))
    await waitFor(() => expect(api.saveCategoryWorkspaceDraft).toHaveBeenCalledTimes(2))
    expect(api.saveCategoryWorkspaceDraft).toHaveBeenLastCalledWith(draftOf('Tea'), 7)
    expect(screen.queryByText('The category draft changed somewhere else')).toBeNull()
  })

  it('can load the other arrangement instead, without writing anything', async () => {
    const user = userEvent.setup()
    await renderProvider({ revision: 3 })
    api.saveCategoryWorkspaceDraft.mockRejectedValueOnce(conflictError(draftOf('Theirs'), 7))

    await act(async () => { ctx.setDraft(draftOf('Coffee')) })
    await user.click(await screen.findByText('Load the other arrangement'))

    expect(ctx.draft).toEqual(draftOf('Theirs'))
    expect(api.saveCategoryWorkspaceDraft).toHaveBeenCalledTimes(1)
  })

  it('shows a failed save and retries it with the next edit, on the same revision', async () => {
    await renderProvider({ revision: 3 })
    api.saveCategoryWorkspaceDraft
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValue({ revision: 4 })

    await act(async () => { ctx.setDraft(draftOf('Coffee')) })
    await screen.findByText('Could not save the category draft')

    await act(async () => { ctx.setDraft(draftOf('Tea')) })
    await waitFor(() => expect(api.saveCategoryWorkspaceDraft).toHaveBeenCalledTimes(2))
    expect(api.saveCategoryWorkspaceDraft).toHaveBeenLastCalledWith(draftOf('Tea'), 3)
  })
})

describe('opening the workspace', () => {
  it('re-reads the shared draft, so a window idle while another saved starts from that arrangement', async () => {
    await renderProvider({ revision: 3 })
    api.getCategoryWorkspaceDraft.mockResolvedValue({ draft: draftOf('Theirs'), revision: 9 })
    api.saveCategoryWorkspaceDraft.mockResolvedValue({ revision: 10 })

    await act(async () => { await ctx.open() })
    expect(ctx.draft).toEqual(draftOf('Theirs'))

    await act(async () => { ctx.setDraft(draftOf('Coffee')) })
    expect(api.saveCategoryWorkspaceDraft).toHaveBeenLastCalledWith(draftOf('Coffee'), 9)
  })

  it('does not replace an arrangement this window has not saved yet', async () => {
    await renderProvider({ revision: 3 })
    api.saveCategoryWorkspaceDraft.mockReturnValue(new Promise(() => {}))
    act(() => { ctx.setDraft(draftOf('Coffee')) })
    api.getCategoryWorkspaceDraft.mockResolvedValue({ draft: draftOf('Theirs'), revision: 9 })

    await act(async () => { await ctx.open() })
    expect(ctx.draft).toEqual(draftOf('Coffee'))
  })
})

describe('applying the draft', () => {
  const unassigned = { id: 'unassigned', parent_id: null, name: 'Unassigned', system_key: 'unassigned', category_type: 'expense' }
  const coffee = { id: 'coffee', parent_id: 'unassigned', name: 'Coffee', import_pending: 1, set_aside: 0 }
  const tolls = { id: 'tolls', parent_id: 'unassigned', name: 'Tolls', import_pending: 1, set_aside: 1 }
  const food = { id: 'food', parent_id: null, name: 'Food & Drink', category_type: 'expense' }
  const applied = {
    snapshot: {
      tree: {
        income: [],
        expense: [{ id: 'g1', name: 'Food & Drink', children: [{ id: 'n1', name: 'Coffee shops', sourceValue: 'Coffee' }] }],
      },
      sourceOrder: [],
      setAsideOrder: ['Tolls'],
    },
  }

  it('sends the whole draft as one plan naming live categories by id', async () => {
    await renderProvider()
    act(() => { ctx.handleCategoriesChanged([unassigned, coffee, tolls, food]) })
    api.applyImportedCategoryWorkspace.mockResolvedValue({ categories: [unassigned, tolls, food] })
    api.saveCategoryWorkspaceDraft.mockResolvedValue({ revision: 4 })

    await act(async () => { await ctx.applyDraft(applied) })

    expect(api.applyImportedCategoryWorkspace).toHaveBeenCalledTimes(1)
    expect(api.applyImportedCategoryWorkspace).toHaveBeenCalledWith({
      groups: [{ name: 'Food & Drink', category_type: 'expense', categories: [{ id: 'coffee', name: 'Coffee shops' }] }],
      set_aside_ids: ['tolls'],
    })
  })

  it('reloads the tree and says so when the server refuses the plan', async () => {
    await renderProvider()
    act(() => { ctx.handleCategoriesChanged([unassigned, coffee, tolls, food]) })
    api.getCategories.mockClear()
    api.applyImportedCategoryWorkspace.mockRejectedValue(new Error('Some of these categories were organized somewhere else.'))

    await act(async () => { await ctx.applyDraft(applied) })

    await screen.findByText('Could not organize imported categories')
    expect(api.getCategories).toHaveBeenCalled()
  })
})
