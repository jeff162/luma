// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from 'react'

/*
 * Unsaved edits to suggestions on the Generate Rules review, and the inline editors on a card that make
 * them.
 *
 * An edit is an *override* held here, keyed by suggestion id, until the suggestion is saved; nothing is
 * written to the review state before then. `resolve` merges a suggestion's override into it, and every
 * consumer — the card, bulk actions, the rule editor, the matching-transactions report, a conflict card —
 * reads suggestions through it, so all of them see the same unsaved edits. A `remove*` flag records that
 * the user took a criterion or action off, which an absent value could not distinguish from "unchanged".
 * Overrides for suggestions that no longer exist are dropped.
 *
 * At most one inline editor of each kind is open at a time: the category picker, the tag picker, the
 * rename field and the keyword field each track the one suggestion they are open on.
 *
 * Category names are looked up through a ref that a newly created category is added to at once, because
 * an edit can pick a category in the same moment it is created, before the `categories` prop catches up.
 */
export function useSuggestionDrafts({ suggestions, categories, owners, accounts, onReloadTags }) {
  const [overrides, setOverrides] = useState({})
  const [renameEdit, setRenameEdit] = useState(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [keywordEditId, setKeywordEditId] = useState(null)
  const [keywordDraft, setKeywordDraft] = useState('')
  const [categoryEditId, setCategoryEditId] = useState(null)
  const [categoryPickerOpenToken, setCategoryPickerOpenToken] = useState(0)
  const [tagEditId, setTagEditId] = useState(null)
  const categoryPickerHasOpenedRef = useRef(false)
  const latestCategoriesRef = useRef(categories)

  useEffect(() => {
    latestCategoriesRef.current = categories
  }, [categories])

  useEffect(() => {
    const present = new Set(suggestions.map(suggestion => String(suggestion.id)))
    setOverrides(prev => {
      const kept = Object.entries(prev).filter(([id]) => present.has(id))
      return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept)
    })
  }, [suggestions])

  const keyOf = suggestion => String(suggestion.id)
  const categoryById = categoryId => (categoryId
    ? latestCategoriesRef.current.find(category => String(category.id) === String(categoryId)) || null
    : null)

  function patch(suggestion, fields) {
    const key = keyOf(suggestion)
    setOverrides(prev => ({ ...prev, [key]: { ...(prev[key] || {}), ...fields } }))
  }

  function resolve(suggestion) {
    const override = overrides[keyOf(suggestion)] || {}
    const has = field => Object.prototype.hasOwnProperty.call(override, field)
    const ownerId = override.removeOwner ? null : (has('ownerId') ? override.ownerId : suggestion.owner_id)
    const accountId = override.removeAccount ? null : (has('accountId') ? override.accountId : suggestion.account_id)
    return {
      ...suggestion,
      keyword: override.keyword ?? suggestion.keyword,
      target_category_id: override.removeCategory ? null : (override.targetCategoryId ?? suggestion.target_category_id),
      target_category_name: override.removeCategory ? null : (override.targetCategoryName ?? suggestion.target_category_name),
      amount_min: override.removeAmount ? null : (has('amountMin') ? override.amountMin : suggestion.amount_min),
      amount_max: override.removeAmount ? null : (has('amountMax') ? override.amountMax : suggestion.amount_max),
      owner_id: ownerId,
      owner_name: ownerId ? (owners.find(owner => String(owner.id) === String(ownerId))?.name || suggestion.owner_name) : null,
      account_id: accountId,
      account_name: accountId ? (accounts.find(account => String(account.id) === String(accountId))?.name || suggestion.account_name) : null,
      clean_name_suggestion: override.removeRename ? null : (override.cleanName ?? suggestion.clean_name_suggestion),
      tag_ids: override.tagIds ?? (suggestion.tag_ids || []),
      match_source_text: override.matchSourceText ?? !!suggestion.match_source_text,
    }
  }

  // The rule editor's whole form, kept as this suggestion's draft.
  function keepEditorDraft(suggestion, data) {
    patch(suggestion, {
      keyword: data.keyword || suggestion.keyword,
      targetCategoryId: data.category_id || null,
      targetCategoryName: categoryById(data.category_id)?.name || null,
      removeCategory: !data.category_id,
      amountMin: data.amount_min ?? null,
      amountMax: data.amount_max ?? null,
      removeAmount: Boolean(data.clear_amount_min) && Boolean(data.clear_amount_max),
      ownerId: data.owner_id || null,
      removeOwner: Boolean(data.clear_owner),
      accountId: data.account_id || null,
      removeAccount: Boolean(data.clear_account),
      cleanName: data.clean_name || '',
      removeRename: !data.clean_name,
      tagIds: data.tag_ids || [],
      matchSourceText: !!data.match_source_text,
    })
  }

  // `flag` is one of the override's remove* fields.
  function remove(suggestion, flag) {
    patch(suggestion, { [flag]: true })
    if (renameEdit === keyOf(suggestion)) cancelRename()
    if (categoryEditId === keyOf(suggestion)) setCategoryEditId(null)
  }

  function setCategory(suggestion, categoryId) {
    patch(suggestion, {
      targetCategoryId: categoryId || null,
      targetCategoryName: categoryById(categoryId)?.name || null,
      removeCategory: !categoryId,
    })
    setCategoryEditId(null)
    categoryPickerHasOpenedRef.current = false
  }

  function setTag(suggestion, tagId, present) {
    const key = keyOf(suggestion)
    setOverrides(prev => {
      const current = prev[key] || {}
      const tags = current.tagIds ?? (suggestion.tag_ids || [])
      const tagIds = present ? (tags.includes(tagId) ? tags : [...tags, tagId]) : tags.filter(id => id !== tagId)
      return { ...prev, [key]: { ...current, tagIds } }
    })
  }

  function cancelRename() {
    setRenameEdit(null)
    setRenameDraft('')
  }

  function cancelKeyword() {
    setKeywordEditId(null)
    setKeywordDraft('')
  }

  return {
    resolve,
    keepEditorDraft,
    remove,
    categoryById,
    // A category created from a picker, available to the next lookup before the prop updates.
    noteCategories: next => { if (Array.isArray(next)) latestCategoriesRef.current = next },
    setCategory,
    category: {
      isEditing: suggestion => categoryEditId === keyOf(suggestion),
      openToken: categoryPickerOpenToken,
      begin(suggestion) {
        categoryPickerHasOpenedRef.current = false
        setCategoryEditId(keyOf(suggestion))
        setCategoryPickerOpenToken(token => token + 1)
      },
      // Some close events fire before the picker has ever shown; those must not end the edit.
      pickerOpenChanged(suggestion, open) {
        if (open) {
          categoryPickerHasOpenedRef.current = true
          return
        }
        if (!categoryPickerHasOpenedRef.current) return
        setCategoryEditId(current => (current === keyOf(suggestion) ? null : current))
        categoryPickerHasOpenedRef.current = false
      },
    },
    tags: {
      isEditing: suggestion => tagEditId === keyOf(suggestion),
      begin(suggestion) {
        setTagEditId(keyOf(suggestion))
        Promise.resolve(onReloadTags?.()).catch(() => {})
      },
      close: () => setTagEditId(null),
      set: setTag,
    },
    rename: {
      isEditing: suggestion => renameEdit === keyOf(suggestion),
      draft: renameDraft,
      setDraft: setRenameDraft,
      begin(suggestion) {
        setRenameEdit(keyOf(suggestion))
        setRenameDraft(resolve(suggestion).clean_name_suggestion || '')
      },
      commit(suggestion) {
        const cleanName = renameDraft.trim()
        patch(suggestion, { cleanName, removeRename: !cleanName })
        cancelRename()
      },
      cancel: cancelRename,
    },
    keyword: {
      isEditing: suggestion => keywordEditId === keyOf(suggestion),
      draft: keywordDraft,
      setDraft: setKeywordDraft,
      begin(suggestion) {
        setKeywordEditId(keyOf(suggestion))
        setKeywordDraft(resolve(suggestion).keyword || '')
      },
      commit(suggestion) {
        patch(suggestion, { keyword: keywordDraft.trim() || suggestion.keyword })
        cancelKeyword()
      },
      cancel: cancelKeyword,
    },
  }
}
