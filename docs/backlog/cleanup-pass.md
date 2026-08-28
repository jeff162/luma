# Cleanup pass (batched low-priority items)

> **Status: backlog.** Small, non-urgent cleanups to do together in a dedicated pass — none block
> current work. Verify with `cd frontend && npm run lint` + the browser console per page.
> Reconciled against the tree on 2026-06-24.

## 1. Console-cleanliness pass

Load each main page in the browser, collect console errors + warnings, and knock out the cheap/recurring
ones so the baseline console is quiet — the point is **signal preservation**: a clean console means a
*new* real error stands out instead of being lost in known noise. Prioritize React warnings (they
usually flag real latent bugs) and accessibility advisories; ignore one-off third-party/extension noise.
(Example already fixed: the Categories search input lacked `name`/`id` → added
`name="category-search"` + `autoComplete="off"`.)

## 2. Native `title` → shared `Tooltip` migration (final step)

A single shared hover/focus tooltip already exists — `Tooltip` in `frontend/src/components/ui.jsx`:
themed (matches dark/light, unlike native `title`), portaled + `position: fixed` so it escapes
`overflow` clipping, distinct border, `tone="warning"` variant, focus/blur for keyboard. The earlier
steps migrated the `TransactionRow.jsx` tag / tag-stack / note-glyph / duplicate-marker sites and the
Transactions row action icons (merchant + category `↗`, edit `✎`) and deleted the local `HoverTooltip`.

**Done since this note was first written (2026-06-24):**
- `Tooltip` gained a **`triggerStyle`** prop — the wrapper-shrink/ellipsize enabler this item said was
  needed before wrapping truncating flex cells.
- `MerchantCell`'s merchant text-cell hint (full-text-on-truncation) was migrated off native `title`
  onto the shared `Tooltip` as part of the import-source origin hover (it now shows the full name plus
  the captured source text). So the merchant text cell is handled.

**Remaining:** ~257 native `title=` occurrences across ~55 frontend files (heaviest in
Settings / ImportExport / Categories / Accounts / UnifiedDuplicatesDialog), plus a few specific
stragglers:
- `CategoryCell`'s "click to change category" text-cell hint, and the account cell — both
  ellipsis-in-flex, so use `triggerStyle` to preserve truncation and verify visually.
- the bulk-select checkboxes, which go through the shared `SelectAllCheckbox` — convert that component
  once, consistently, rather than piecemeal.
- re-skin the Accounts drag "can't merge" tooltip and `FeatureExplainer` to the shared tokens (keep
  their distinct trigger/tone).

Migration is mechanical (`title="x"` → wrap with `<Tooltip content="x">`), in batches, highest-visibility
first. **Keep accessibility parity:** add an `aria-label` / `aria-describedby` so it matches native
`title` (screen reader + touch). Leave alone: the Recharts `CustomTooltip` (`detailShared.jsx`), and
remember `NoteCell` (`title={txn.notes}` / "Add note") is **dead code** — handle it in the dead-code
sweep below, not here. Native `title` is also a *legitimate* choice where its viewport-escaping edge
behavior matters (see `ui-patterns.md`) — this migration is about consistency, not eradication.

## 3. Dead-code sweep

Remove the unreferenced legacy files (the user keeps these for possible reuse, so remove only in a
deliberate sweep — all five still present as of 2026-06-24):
- `frontend/src/components/CategoryPickerLegacy.jsx`
- `frontend/src/components/CategoryPickerFlatSearchLegacy.jsx`
- `frontend/src/components/ImportCategoryMappingWorkspaceBucketsLegacy.jsx`
- `frontend/src/components/ImportCategoryMappingWorkspaceLegacy.jsx`
- `frontend/src/lib/importCategoryMappingStateLegacy.js`

Worth knowing before reusing either category picker rather than deleting it: `handleSave` in both has
no rejection path, so a failed create leaves the dialog stuck on "Saving…" with the button disabled and
no way out. Found during the 2026-08-20 sweep that fixed the same shape everywhere it was live, and
deliberately not fixed here, since fixing code nothing renders only makes it look maintained.

Also the unused `NoteCell` in `TransactionRow.jsx`. (The orphaned `backend/routers/categorizer.py`
duplicate was already deleted.)

## 4. Opt-in per-detail-panel Refresh

After a bulk edit the detail panels reconcile rows in place, so a row recategorized out of scope
*lingers* until the panel is re-drilled. Transactions + Categories have their own reload/Refresh; the
detail panels don't. Deliberately **not** added preemptively — lingering rows are correctable in place
and a mis-tap stays visible. Add when a real need shows up.

The seam is an **opt-in `onRefresh`** callback on `lib/useBulkTransactionEditing.jsx`; `BulkEditChrome`
renders a `↻ Refresh` next to the bar only when a host passes one (shared half ≈5 lines). Per-host wiring
(Categories is the reference — it bumps `matchingReloadNonce` into the paging key):
- PeriodDetail / TagDetail: add a `refreshNonce` to the fetch `useEffect` deps.
- CategoryDetail / AccountDetail / ImportBatchDetail: thread a nonce into the `usePaged…Transactions`
  `activeKey` (ImportBatchDetail also re-fetches its count).
- Dashboard: re-invoke its drill fn.

Nothing structural — a prop plus per-host one-liners. See the bulk-select section of `ui-patterns.md`
for the in-place reconcile contract this complements.

## Schema leftovers to fold into the next migration

Not worth a migration of their own; take them the next time one is written for another reason.

- **`idx_recurring_override_pin`** — the partial unique index on
  `recurring_membership_override(txn_id) WHERE state = 'pinned'`. It guarded the withdrawn pinning
  feature (see `backlog/recurring-detection.md` — a series is defined by what recurs, so forcing a row
  in misrepresents it). Nothing writes the state: the endpoint rejects it and `_load_overrides` filters
  on `'excluded'`. The index is inert, and dropping it does not change behavior — which is exactly why
  it should ride along rather than justify its own version bump. Drop the index; leave the `state`
  column, since `'excluded'` still uses it.

## Press-scoped transient labels (from the 2026-08-19 flicker sweep)

A sweep for flicker converted the busy indicators driven by a **load** (`useBusyIndicator`) and the
spinners that **replaced content on reload** (`{loading && rows.length === 0 ? <Spinner/> : rows}`) — see
`ui-patterns.md`. What it deliberately left is the ~61 labels driven by a **press**: `Saving…`,
`Deleting…`, `Emptying…`, `Applying…`, `Importing…` on the button the user just clicked.

They are a different judgement, and it does not generalize. Suppressing the label for 150 ms means a fast
save shows *nothing at all*, which is right where the result is visible (the row vanishes, the dialog
closes) and wrong where the button just sits there — the user presses again. So each site needs the
question "does anything else on screen change when this succeeds?", which is why it wasn't swept.

Find them with `grep -rn "? '[A-Z][a-z]*…'" frontend/src --include=*.jsx`.

Also left as deliberate swaps: the Dashboard's group→category drill spinners. Drilling loads *different*
content, so there is no stale content worth keeping — the previous level's rows under the new level's
heading would be wrong, not merely old.

