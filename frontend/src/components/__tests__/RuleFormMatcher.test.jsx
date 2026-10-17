// @vitest-environment jsdom

// Editing a saved rule sends every field the form holds, and an empty one goes as cleared. So whatever an
// editor fails to seed from the rule is silently stripped on save: a matcher flattened to its derived
// keyword, an account-type scope dropped, a recurring series deleted. These pin the round trip and the
// two-list matcher that rides on it.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import RuleForm, { ruleFormInitialValues } from '../RuleForm.jsx'

vi.mock('../../lib/api.js', () => ({
  api: new Proxy({}, {
    get: (_target, name) => () => Promise.resolve(name === 'previewRule' ? { count: 0, transactions: [] } : []),
  }),
}))
vi.mock('../../lib/UserPreferencesContext.jsx', () => ({
  useUserPreference: (_key, fallback) => [fallback, () => {}],
}))

afterEach(cleanup)

function renderForm(initialValues) {
  const onDraftChange = vi.fn()
  render(
    <MemoryRouter>
      <RuleForm
        initialValues={initialValues}
        categories={[]}
        owners={[]}
        accounts={[]}
        onSave={vi.fn()}
        onCancel={vi.fn()}
        onDraftChange={onDraftChange}
      />
    </MemoryRouter>,
  )
  return () => onDraftChange.mock.calls.at(-1)[0].data
}

describe('RuleForm editing a saved rule', () => {
  it('saves back everything the rule had', () => {
    const latestDraft = renderForm(ruleFormInitialValues({
      id: 'r1', keyword: 'northgate nrthgt market', alternatives: ['northgate', 'nrthgt'], clauses: ['market'],
      category_id: 'c1', account_type: 'credit', match_source_text: 1,
      is_recurring: 1, recurring_cadence: 'quarterly',
    }))
    expect(latestDraft()).toMatchObject({
      alternatives: ['northgate', 'nrthgt'],
      clauses: ['market'],
      account_type: 'credit',
      clear_account_type: false,
      match_source_text: true,
      is_recurring: true,
      cadence: 'quarterly',
    })
  })

  it('turns a plain keyword into alternatives with an "or contains" row', async () => {
    const user = userEvent.setup()
    const latestDraft = renderForm(ruleFormInitialValues({ id: 'r2', keyword: 'northgate', clauses: ['northgate'], category_id: 'c1' }))
    await user.click(screen.getByRole('button', { name: /or contains/ }))
    await user.type(screen.getByLabelText('Rule merchant alternative 2'), 'nrthgt')
    expect(latestDraft()).toMatchObject({ alternatives: ['northgate', 'nrthgt'], clauses: [] })
  })
})
