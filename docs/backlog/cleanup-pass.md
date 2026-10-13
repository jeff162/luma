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
first — and each batch owes the accessibility parity the shared `Tooltip` does not give for free (see
[`../ui-patterns.md`](../ui-patterns.md) → *Loading and feedback*), which is what keeps it from being a
find-and-replace. Leave alone: the Recharts `CustomTooltip` (`detailShared.jsx`), and
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

Nothing structural — a prop plus per-host one-liners. See `ui-patterns.md` → *Transaction lists*
for the in-place reconcile contract this complements.

## 5. `category_owner_ids` — the client half

The dead `category_owner_ids` query parameter was removed from `/summary/by-group` (it was declared and
never read; its three sibling summary endpoints never had it). The client half is still there:
`getGroupTotals` and `getCategoryTotals` in `frontend/src/lib/api.js` both take it as a **positional**
argument, and all four call sites in `Dashboard.jsx` pass `undefined`. Nothing is sent, so this is tidying
rather than a fix. It was left out of the backend change deliberately: removing a positional argument
shifts every call site, and a miscount silently swaps `dateStart`/`ownerIds` — a change that wants the app
in front of someone, not a lint run. `getCategoryTotals` is the clearer of the two, since
`/summary/by-category` never declared the parameter at all.

## The file report's *Not imported* view, on batches older than it

Three small things the view cannot do well for a batch imported before `import_batch_rejected_row`
existed, where its rows come from the up-to-twenty sample in the snapshot instead (`data-model.md` →
*Import batches and profiles*). All three are invisible on anything imported since.

- **The Date / Description / Amount columns read `—`** on those rows, because the snapshot stored only
  the file's raw cells and not the parsed fields. The cells themselves are there — a row shows its
  `Original Description` while the Description column is blank, which reads as a defect. Fill the three
  from `values` using the batch's saved `column_map` when a row has no parsed field, in
  `get_batch_not_imported` (`routers/import_export/core.py`).
- **A reason pill whose rows were never stored filters to nothing**, and the empty state then says "No
  rows match the current search or filter", which blames the filter for an absence that is about the
  record. Seen as *Skipped account (17)* on a pre-migration batch holding five zero-amount rows and
  nothing else. Either say that case plainly or drop the pill when no row of that kind was kept —
  dropping it loses the count, which is true and worth showing, so the message is probably the better
  half.
- **The card's pill and the view's count are about different sets** — the pill counts the three
  *rejected* kinds it always has, while *Not imported (N)* adds account-skipped and trailing rows, so a
  card can read "3 rejected" and open on twelve. Both numbers are honest and the mismatch is still odd
  on screen. Changing what the pill counts changes what the card reports, so it is a decision rather
  than a fix.

## Schema leftovers to fold into the next migration

*(Empty — `idx_recurring_override_pin` rode along with migration 46 on 2026-09-01. Kept as a heading
because the pattern recurs: an inert schema leftover is worth queueing rather than version-bumping for,
and the queue only works if something is checked when the next migration is written.)*

## Press-scoped transient labels (from the 2026-08-19 flicker sweep)

**Unstarted, and deliberately not sweepable.** The 2026-08-19 sweep converted the busy indicators driven
by a **load** and the spinners that replaced content on reload; it left the ~61 labels driven by a
**press** (`Saving…`, `Deleting…`, `Applying…`, `Importing…`). Why they are a different judgement — and
the one question each site has to answer — is in [`../ui-patterns.md`](../ui-patterns.md) → *Loading and
feedback*. What is left here is the pass itself: visit each site, answer the question, and convert only
the ones where something else on screen already reports success.

Find them with `grep -rn "? '[A-Z][a-z]*…'" frontend/src --include=*.jsx`.
