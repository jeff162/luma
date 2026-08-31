// @vitest-environment jsdom

// The rule editor's header actions. The form itself is stubbed out — what is worth pinning here is the
// delete affordance, which is destructive and sits two clicks from a Save button.
//
// The property most likely to regress is the separation of the two re-evaluate opt-ins. The header
// already carried one for the *edit* ("rows this edit drops from scope revert"), and the delete confirm
// carries its own for the *deletion*; they ask the same question about different acts. Sharing one piece
// of state would look like a tidy-up and would mean a box ticked while considering a delete, then
// abandoned, silently reverting transactions on the next Save.

import { afterEach, describe, it, expect, vi } from 'vitest'
import { forwardRef } from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EditRuleOverlay } from '../Rules.jsx'

vi.mock('../../components/RuleForm.jsx', () => ({
  default: forwardRef(function RuleFormStub(props, ref) {
    void ref
    return <div data-testid="rule-form" />
  }),
  amountConditionSummary: () => null,
  RulePreviewDetail: () => null,
}))

afterEach(() => { cleanup(); vi.clearAllMocks() })

const RULE = {
  id: 'r1', keyword: 'northgate', clauses: ['northgate'], category_id: 'c1',
  amount_min: null, amount_max: null, debit_credit: 'both', tag_ids: [],
}

function renderOverlay() {
  const onDelete = vi.fn()
  const onSave = vi.fn().mockResolvedValue(undefined)
  render(
    <EditRuleOverlay
      rule={RULE}
      categories={[]}
      owners={[]}
      accounts={[]}
      onSave={onSave}
      onDelete={onDelete}
      onCancel={vi.fn()}
    />,
  )
  return { onDelete, onSave }
}

describe('the rule editor header', () => {
  it('offers a delete that confirms before it acts', async () => {
    const { onDelete } = renderOverlay()
    await userEvent.click(screen.getByLabelText('Delete this rule'))
    expect(onDelete).not.toHaveBeenCalled()
    await userEvent.click(screen.getByText('Delete rule'))
    expect(onDelete).toHaveBeenCalledWith('r1', false)
  })

  it('says where a deleted rule goes, since it is recoverable', async () => {
    renderOverlay()
    await userEvent.click(screen.getByLabelText('Delete this rule'))
    expect(screen.getByText(/rules trash/)).toBeTruthy()
  })

  it('carries the re-evaluate opt-in into the delete', async () => {
    const { onDelete } = renderOverlay()
    await userEvent.click(screen.getByLabelText('Delete this rule'))
    await userEvent.click(screen.getByLabelText(/Also re-evaluate/))
    await userEvent.click(screen.getByText('Delete rule'))
    expect(onDelete).toHaveBeenCalledWith('r1', true)
  })

  // The confirm's dismiss is "Keep rule", not "Cancel" — the editor's own Cancel sits behind it and
  // abandons the whole edit, so one word for two outcomes would be a real ambiguity, not just an
  // ambiguous query.
  it('abandons the delete without abandoning the edit', async () => {
    const { onDelete } = renderOverlay()
    await userEvent.click(screen.getByLabelText('Delete this rule'))
    await userEvent.click(screen.getByText('Keep rule'))
    expect(onDelete).not.toHaveBeenCalled()
    expect(screen.queryByText('Delete rule')).toBeNull()
  })

  it('does not let a considered-then-abandoned delete change what a save does', async () => {
    const { onSave, onDelete } = renderOverlay()
    await userEvent.click(screen.getByLabelText('Delete this rule'))
    await userEvent.click(screen.getByLabelText(/Also re-evaluate/))
    await userEvent.click(screen.getByText('Keep rule'))
    await userEvent.click(screen.getByText('Save changes'))
    expect(onDelete).not.toHaveBeenCalled()
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ reconcile: false }))
  })
})
