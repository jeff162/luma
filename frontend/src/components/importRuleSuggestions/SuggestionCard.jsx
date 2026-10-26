// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import CategoryPicker from '../CategoryPicker.jsx'
import TagPickerWithCreate from '../TagPickerWithCreate.jsx'
import { TagBadge } from '../TagUi.jsx'
import { FilterChip, IconButton, Tooltip } from '../ui.jsx'
import { buildCategoryDisplayLabel, getSuggestionFilterPills, isRefinedPendingSuggestion } from '../../lib/importRuleSuggestions.js'
import {
  CriteriaGroup,
  ReportArrowButton,
  SuggestionDispositionActions,
  SuggestionPill,
  SuggestionStatusBadge,
} from './suggestionPresentational.jsx'

/*
 * One suggestion on the Generate Rules review: its matcher, its actions (category, rename, tags) and the
 * buttons that decide it. Everything is edited in place through `drafts` (`useSuggestionDrafts`), so what
 * the card shows is the suggestion with its unsaved edits merged in.
 *
 * Props come grouped by where they are owned: `view` is where the card sits (which list, its place in a
 * conflict set), `selection` is bulk selection (`useSuggestionBulkSelection`), `catalog` is the
 * categories and tags to choose from, and `handlers` are the page's actions on a suggestion.
 */
export function SuggestionCard({ suggestion, view, selection, drafts, catalog, handlers }) {
  const { filterKey, isConflictFollower, isConflictLead, leadHasVisibleChildren, allowConflictOpen, isOlder } = view
  const { categories, tags, onCategoriesChanged, onTagCreated } = catalog
  const bulkMode = selection.active
  const resolvedSuggestion = drafts.resolve(suggestion)
  const filterPills = getSuggestionFilterPills(resolvedSuggestion)
  const showConflictMarker = Boolean(suggestion.conflict_group_id) && filterKey !== 'pending'
  const editingTags = drafts.tags.isEditing(suggestion)
  const refined = isRefinedPendingSuggestion(resolvedSuggestion)

  const statusBadge = suggestion.review_status === 'accepted'
    ? { label: 'Accepted', tone: 'accepted' }
    : suggestion.review_status === 'skipped'
      ? { label: 'Deferred', tone: 'skipped' }
      : suggestion.review_status === 'discarded'
        ? { label: 'Removed', tone: 'discarded' }
        : isOlder
          ? { label: 'Older', tone: 'older' }
          : null
  const showStatusBadge = Boolean(statusBadge && ['total', 'accepted', 'deferred', 'discarded', 'older'].includes(filterKey))
  const returnsToPending = suggestion.review_status === 'accepted' || suggestion.review_status === 'skipped'
  const removeActionStatus = returnsToPending ? 'pending' : 'discarded'
  const removeTitle = returnsToPending ? 'Return suggestion to pending' : 'Discard suggestion'

  const actions = [
    resolvedSuggestion.target_category_id
      ? {
        key: 'category',
        label: `category: ${buildCategoryDisplayLabel(categories, resolvedSuggestion.target_category_id, resolvedSuggestion.target_category_name)}`,
        onRemove: () => drafts.remove(suggestion, 'removeCategory'),
        onMouseDown: () => drafts.category.begin(suggestion),
      }
      : null,
    resolvedSuggestion.clean_name_suggestion
      ? {
        key: 'rename',
        label: `rename to ${resolvedSuggestion.clean_name_suggestion}`,
        onRemove: () => drafts.remove(suggestion, 'removeRename'),
        onClick: () => drafts.rename.begin(suggestion),
        editing: drafts.rename.isEditing(suggestion),
        editValue: drafts.rename.draft,
        onEditValueChange: drafts.rename.setDraft,
        onEditCommit: () => drafts.rename.commit(suggestion),
        onEditCancel: drafts.rename.cancel,
      }
      : null,
  ].filter(Boolean)

  const leftInset = (showStatusBadge ? 44 : 16) + (bulkMode ? 28 : 0)
  const rightInset = suggestion.review_status === 'discarded' ? 16 : 52

  return (
    <div
      data-rule-suggestion-card=""
      data-rule-suggestion-id={String(suggestion.id)}
      onContextMenu={event => handlers.onContextMenu(event, suggestion, resolvedSuggestion)}
      style={{
        position: 'relative',
        marginLeft: isConflictFollower ? 30 : 0,
        // Each card is its own stacking context (position + z-index), so an inline popover (the tag
        // picker) can't paint over the *next* card unless this card outranks it while open.
        zIndex: editingTags ? 30 : 0,
        border: '1px solid var(--border)',
        borderRadius: 14,
        overflow: 'visible',
        background: 'color-mix(in srgb, var(--surface2) 70%, var(--surface))',
      }}
    >
      {isConflictFollower ? (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: -12,
            top: -10,
            bottom: -10,
            width: 8,
            borderLeft: '2px solid color-mix(in srgb, var(--text) 28%, var(--border))',
            borderRight: '2px solid color-mix(in srgb, var(--text) 18%, var(--border))',
            borderRadius: 999,
            pointerEvents: 'none',
            opacity: 0.95,
          }}
        />
      ) : null}
      {bulkMode ? (
        <label aria-label="Select this suggestion" style={{
          position: 'absolute',
          top: 13,
          left: 14,
          zIndex: 2,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 20,
          height: 20,
          cursor: 'pointer',
        }}>
          <input
            type="checkbox"
            checked={selection.isSelected(suggestion.id)}
            onChange={() => (leadHasVisibleChildren ? selection.toggleConflictLead(suggestion) : selection.toggle(suggestion.id))}
            style={{ width: 16, height: 16, accentColor: 'var(--accent)', cursor: 'pointer' }}
          />
        </label>
      ) : null}
      {showStatusBadge ? (
        <SuggestionStatusBadge label={statusBadge.label} tone={statusBadge.tone} left={bulkMode ? 42 : 14} />
      ) : null}
      {suggestion.review_status === 'accepted' ? (
        <Tooltip content={removeTitle} align="right" triggerStyle={{ position: 'absolute', top: 10, right: 10, zIndex: 1 }}>
          <IconButton
            tone="danger"
            aria-label={removeTitle}
            title=""
            onClick={() => handlers.runRowStatusAction(suggestion, resolvedSuggestion, removeActionStatus)}
          >
            ×
          </IconButton>
        </Tooltip>
      ) : null}
      <div style={{
        padding: `11px ${rightInset}px 11px ${leftInset}px`,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 14,
        flexWrap: 'wrap',
      }}>
        <div style={{ minWidth: 0, flex: '1 1 280px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
            <CriteriaGroup
              merchantLabel={resolvedSuggestion.merchant_label}
              keyword={resolvedSuggestion.keyword}
              filterPills={filterPills}
              onRemoveFilter={flag => drafts.remove(suggestion, flag)}
              editing={drafts.keyword.isEditing(suggestion)}
              draftValue={drafts.keyword.draft}
              onEditSuggestion={() => handlers.onEditSuggestion(suggestion.id)}
              onBeginKeywordEdit={() => drafts.keyword.begin(suggestion)}
              onKeywordChange={drafts.keyword.setDraft}
              onKeywordCommit={() => drafts.keyword.commit(suggestion)}
              onKeywordCancel={drafts.keyword.cancel}
            />
            {suggestion.txn_count ? (
              <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                {suggestion.txn_count} matching row{suggestion.txn_count === 1 ? '' : 's'}
                <ReportArrowButton onClick={() => handlers.onOpenReport(suggestion)} />
              </span>
            ) : null}
            {showConflictMarker ? (
              <button
                type="button"
                onClick={() => {
                  if (!allowConflictOpen || !suggestion.conflict_group_id) return
                  handlers.onOpenConflictSet(suggestion.conflict_group_id)
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '3px 8px',
                  borderRadius: 999,
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'color-mix(in srgb, var(--warning) 72%, var(--text))',
                  background: 'color-mix(in srgb, var(--warning) 10%, var(--surface2))',
                  border: '1px solid color-mix(in srgb, var(--warning) 28%, var(--border))',
                  whiteSpace: 'nowrap',
                  cursor: allowConflictOpen ? 'pointer' : 'default',
                }}
              >
                conflict set
              </button>
            ) : null}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>actions:</span>
            {actions.length > 0 ? actions.map(action => (
              action.key === 'category' && drafts.category.isEditing(suggestion) ? (
                <div key={action.key} style={{ minWidth: 240, maxWidth: 320, flex: '0 1 320px' }}>
                  <CategoryPicker
                    value={resolvedSuggestion.target_category_id}
                    categories={categories}
                    onChange={value => drafts.setCategory(suggestion, value)}
                    onCategoryCreated={async () => drafts.noteCategories(await onCategoriesChanged?.())}
                    compact
                    openToken={drafts.category.openToken}
                    onOpenChange={open => drafts.category.pickerOpenChanged(suggestion, open)}
                  />
                </div>
              ) : (
                <SuggestionPill
                  key={action.key}
                  label={action.label}
                  onRemove={action.onRemove}
                  onClick={action.onClick}
                  onMouseDown={action.onMouseDown}
                  editing={action.editing}
                  editValue={action.editValue}
                  onEditValueChange={action.onEditValueChange}
                  onEditCommit={action.onEditCommit}
                  onEditCancel={action.onEditCancel}
                />
              )
            )) : (
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>none</span>
            )}
          </div>

          {(resolvedSuggestion.tag_ids?.length || editingTags) ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>tags:</span>
              <span style={{ position: 'relative', display: 'inline-flex' }}>
                <FilterChip
                  variant="add"
                  // Open-only: while the picker is open its own outside-click dismissal closes it, so a
                  // toggling onClick would close-then-reopen on the same click.
                  onClick={editingTags ? undefined : () => drafts.tags.begin(suggestion)}
                >
                  + tag
                </FilterChip>
                {editingTags ? (
                  <TagPickerWithCreate
                    allTags={tags}
                    selectedTagIds={new Set(resolvedSuggestion.tag_ids)}
                    onToggleTag={(tag, present) => drafts.tags.set(suggestion, tag.id, present)}
                    onTagCreated={created => onTagCreated?.(created)}
                    onClose={drafts.tags.close}
                    positioning="absolute"
                    align="left"
                  />
                ) : null}
              </span>
              {resolvedSuggestion.tag_ids.map(tagId => {
                const tag = tags.find(item => String(item.id) === String(tagId))
                if (!tag) return null
                return (
                  <span key={tagId} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <TagBadge tag={tag} />
                    <IconButton size="compact" aria-label={`Remove ${tag.name}`} onClick={() => drafts.tags.set(suggestion, tagId, false)}>
                      ×
                    </IconButton>
                  </span>
                )
              })}
            </div>
          ) : null}

          {suggestion.needs_resolution && filterKey === 'pending' && isConflictLead ? (
            <div style={{ marginTop: 6, fontSize: 12, color: 'color-mix(in srgb, var(--warning) 72%, var(--text))' }}>
              Conflicting category assignments for the same merchant. Pick one or add selection criteria to distinguish them.
            </div>
          ) : null}
        </div>

        <SuggestionDispositionActions
          suggestion={suggestion}
          resolvedSuggestion={resolvedSuggestion}
          editingSuggestionId={handlers.editingSuggestionId}
          onEditSuggestion={handlers.onEditSuggestion}
          runRowStatusAction={handlers.runRowStatusAction}
          runRowSaveAction={handlers.runRowSaveAction}
          onRejectSuggestionDisposition={handlers.onRejectSuggestionDisposition}
          editLabel={refined ? 'Edit selection criteria' : undefined}
          editOpenLabel={refined ? 'Selection editor open' : undefined}
        />
      </div>
    </div>
  )
}
