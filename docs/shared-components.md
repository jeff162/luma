# Shared components index

The lookup for someone about to build UI: what shared component to use for a given job. Reuse is the
default and a one-off needs a stated reason (`ui-patterns.md` → *Consistency and reuse*). The
conventions themselves are in [`ui-patterns.md`](ui-patterns.md); how a component works is in the
header comment of its own file. Paths are under `frontend/src/`.

## Filtering

| Use | For | Where |
| --- | --- | --- |
| `FilterContext` / `FilterBar` | The app-wide date, account, owner and group filter. | `lib/FilterContext.jsx`, `components/FilterBar.jsx` |
| `selectionsToParams` | Turning the filter chips into API parameters. A new filter axis is one row in `FILTER_FACETS` and one in the backend registry (`data-model.md` → *One facet registry, both halves*). | `lib/filterParams.js` |
| `AttributeFilterControl` | A toolbar control that narrows a transaction list to one kind of transaction. | `components/AttributeFilterControl.jsx` |
| `AmountFilterControl` | An amount filter in a toolbar. | `components/AmountFilterControl.jsx` |
| `SearchInput` | The search box of a page or panel. | `components/ui.jsx` |

## Transaction lists

| Use | For | Where |
| --- | --- | --- |
| `TransactionListTable` | Any list of transactions. | `components/TransactionListTable.jsx` |
| `TransactionRow.jsx` cells | A surface that draws its own rows: `CategoryCell`, `MerchantCell`, `TransactionAmountCell`, the name helpers (`getTxnMerchantLabel`, `getTxnName`, `NamelessMerchant`) and the right-click `ContextMenu`. | `components/TransactionRow.jsx` |
| `usePagedTransactions` | A transaction list that loads in pages. It sorts on the server, and its `copy` goes to the list's copy button so a copy reaches past the loaded pages. | `components/detailShared.jsx` |
| `useTransactionTableLayout` | The column order and widths of a `TransactionListTable`. | `lib/transactionTablePreferences.js` |
| `TransactionListToolbar` | The copy and bulk-edit row above a transaction list, with `BulkEditChrome` below it. | `components/TransactionListToolbar.jsx` |
| `CopyTransactionsButton` | Copying one transaction or a list for sharing. A partly loaded list passes `loadRows` and `total`. | `components/CopyTransactionsButton.jsx`, `contexts/TransactionShareContext.jsx` |
| `fetchAllMatchingTransactions` | Fetching every row a filter matches, past the endpoint's per-request cap. | `lib/allMatchingTransactions.js` |
| `useTransactionRowActions` | The row menu and its note, tag, trash, rule and split editors. It owns the surface's split editor, so the row's split marker opens through its `openSplitFromMenu`. | `lib/useTransactionRowActions.jsx` |
| `useBulkTransactionEditing` (+ `BulkEditPanel`, `useTransactionSelection`) | Bulk select and edit. | `lib/useBulkTransactionEditing.jsx`, `components/BulkEditPanel.jsx`, `lib/useTransactionSelection.js` |
| `txnMutations` | Every write that can change a figure derived from transactions, because it is the one place that announces the change to the rest of the app. The raw `api.*` writes are lint-guarded. | `lib/txnMutations.js` |
| `SplitEditorDialog` | Dividing a transaction's amount across categories. | `components/SplitEditorDialog.jsx` |
| `NoteEditor` (+ `NotePopover`) | Editing a transaction's note. | `components/NoteEditor.jsx`, `components/TransactionRow.jsx` |
| `OriginFields` + `importSourceFields` | Showing the import-source detail captured for a row. | `components/OriginFields.jsx`, `lib/importSourceFields.js` |
| `moneyDisplay` | Formatting and coloring an amount. | `lib/moneyDisplay.js` |
| `TransactionDetail` | The detail panel for a transaction or a payee. | `components/TransactionDetail.jsx` |

## Tables and long lists

| Use | For | Where |
| --- | --- | --- |
| `PillGridTable` / `PillTableHeader` | A table with sortable, reorderable or resizable columns. | `components/PillGridTable.jsx`, `components/PillTableHeader.jsx` |
| `useColumnPreference` | Remembering column order and widths. | `lib/useColumnPreference.js` |
| `WindowedRows` | A long list. Heights are measured per item, so section headers can be interleaved with rows. | `components/WindowedRows.jsx` |
| `MatchReport` | A report table that sets each record beside the record it matched. | `components/importExport/MatchReport.jsx` |

## Floating panels and report viewers

| Use | For | Where |
| --- | --- | --- |
| `DetailPanelShell` + `useDetailPanelChrome` | A floating panel that drags, resizes and stacks. | `components/detailShared.jsx` |
| `useRestorablePanelGeometry` | Remembering where the user left a floating panel. | `components/detailShared.jsx` |
| `usePanelReveal` | A panel whose size settles after its content loads. | `components/detailShared.jsx` |
| `DetailRangeControl` + `computeDetailRange` | The Month / Year / All-time selector of a drill list. | `components/detailShared.jsx` |
| `FloatingPanel` / `OverlayBackdrop` | The surface and backdrop under any popover or overlay. | `components/ui.jsx` |
| `useDetachedReportViewer` + `MinimizedReportPill` | A report that stays open across navigation and minimizes to the navigation pane. | `lib/useDetachedReportViewer.js`, `components/MinimizedReportPill.jsx` |
| `useUnifiedDuplicatesViewer` | Opening the duplicate report from any surface. | `contexts/UnifiedDuplicatesViewerContext.jsx` |
| `useReconciliationViewer` | Opening a reconciliation report. A new vendor is an entry in `reconciliationVendors.js` and `RECONCILIATION_REPORTS`, not a new dialog. | `contexts/ReconciliationViewerContext.jsx`, `components/importExport/reconciliation/`, `lib/reconciliationReports.js` |
| `useBatchDetailPanels` | Opening an import's transaction list in place, from any surface. | `components/importExport/useBatchDetailPanels.jsx` |
| `useAccountDetailPanels` | Opening an account's detail panel in place, from any surface. | `components/accounts/useAccountDetailPanels.jsx` |

## Charts

| Use | For | Where |
| --- | --- | --- |
| `DetailTrendChart` | The monthly trend bar chart at the top of a detail panel. | `components/detailShared.jsx` |
| `PanningChartFrame` | A bar chart that may be wider than its card. | `components/PanningChartFrame.jsx` |
| `PanningChartTooltip` | The tooltip of a chart inside a scrolling element, because Recharts places its own against the whole canvas. | `components/PanningChartTooltip.jsx` |
| `TrendsWindowSelect` + `trendsWindowOptions` / `trendsWindowRange` | Choosing which months a set of charts covers. | `components/TrendsWindowSelect.jsx`, `lib/trendBuckets.js` |
| `TrendSpanSelect` + `lib/trendSpan.js` | Choosing how much history a chart draws. It is one persisted setting, so every chart in a frame agrees (`data-model.md` → *Reporting assumptions*). | `components/TrendSpanSelect.jsx`, `lib/trendSpan.js` |
| `alignOnAxis` / `besideOnAxis` | Placing a floating card so it stays inside given bounds. | `lib/floatingPlacement.js` |

## Pages, dialogs and buttons

| Use | For | Where |
| --- | --- | --- |
| `ui.jsx` primitives | `Card`, `Button`, `Select`, `Input`, `Badge`, `Spinner`, `EmptyState`, `Tooltip`, `PageHeader`, `Toggle`, `SelectAllCheckbox`, `CategoryMarker`, and the style helpers `getFormControlStyle` / `getFloatingPanelSurfaceStyle`. | `components/ui.jsx` |
| `SectionListPage` (+ `useSectionParam`, `Subsection`) | A page of many sections that are each visited occasionally. | `components/SectionListPage.jsx` |
| `SegmentedToggle` | Switching between peer views of one subject. | `components/ui.jsx` |
| `AppDialog` / `AppConfirmDialog` / `AppNoticeDialog` / `AppTextEntryDialog` | A dialog that is opened, answered and closed. The body scrolls with the header and actions pinned, so a caller does not cap its own content height. Opened from inside a row or a list, portal it to `<body>`, because it renders where it is mounted. | `components/ui.jsx` |
| `Button`'s `progress` | A long action reporting progress on the button that started it. | `components/ui.jsx` |
| `COMPACT_ACTION_BTN_STYLE` with `variant="ghost"` | An action repeated on every row. | `components/ui.jsx` |
| `RefreshButton` | Reloading what a title names. | `components/ui.jsx` |
| `ActionMenu` + `ActionMenuButton` | The `⋯` menu of rarely used actions. | `components/ActionMenu.jsx` |
| `DropZone` | A click-or-drop file target. | `components/DropZone.jsx` |

## Form fields and editing in place

| Use | For | Where |
| --- | --- | --- |
| `TransientTextInput` | Editing one text value in place. | `components/TransientTextInput.jsx` |
| `uiInteractions` | Click-away and Escape handling: `useDismissibleLayer`, `useEscapeAction`, `useTransientTextEdit`. | `lib/uiInteractions.js` |
| `onEnter` / `advanceOnEnter` | Enter moving through a small form and submitting from the last field. | `lib/formKeys.js` |
| `PasswordInput` (+ `PasswordManagerUsername`) | Any secret that is typed or pasted. | `components/ui.jsx` |
| `lib/sensitiveFields.js` sets | Telling the browser what a sensitive field holds. Pick the set by the field's content, because the wrong one fails silently. | `lib/sensitiveFields.js` |
| `FieldIssue` + `passwordIssue` / `passwordShortfall` | Live feedback on a field that chooses a password. | `components/ui.jsx`, `lib/passwordPolicy.js` |

## Loading and feedback

| Use | For | Where |
| --- | --- | --- |
| `useBusyIndicator` | Any label, spinner or skeleton driven by a `loading` flag. | `lib/useBusyIndicator.js` |
| `StaleWhileRefreshing` | Content kept on screen through a reload that would otherwise look current. | `components/ui.jsx` |
| `UndoToast` | The timed Undo offered after a reversible action. Raised from a dialog, pass `zIndex`, because the default sits below `AppDialog`. | `components/CategoryTreePrimitives.jsx` |
| `summarizeBulkOutcome` | Reporting a bulk of independent requests settled with `Promise.allSettled`. | `lib/bulkRequestOutcome.js` |
| `useRelativeTimestamp` | A standing "how long ago" label, because one computed at render goes stale. | `lib/useRelativeTimestamp.js` |
| `useAfterLedgerSync` | Reloading a page's own copy of transaction-derived data after a sync, because a sync writes on the server and sends no in-app change event. | `contexts/SyncStatusContext.jsx` |

## Pickers and chips

| Use | For | Where |
| --- | --- | --- |
| `CategoryPicker` | Choosing a category. Inside an `AppDialog`, raise `panelZIndex`, because the dropdown portals to `<body>` beneath the dialog. | `components/CategoryPicker.jsx` |
| `CategoryDisplay` | Showing a category read-only. | `components/CategoryDisplay.jsx` |
| `TagPickerWithCreate` | Choosing or creating a tag. | `components/TagPickerWithCreate.jsx` |
| `useTags` | The tag list for a picker, cached app-wide. It is not for use in each row of a list. | `lib/useTags.js` |
| `TagUi` | Drawing a tag (`TagGlyph`, `TagBadge`), and the tag palette. | `components/TagUi.jsx` |
| `OwnerChip` | Showing an owner as a pill, read-only or as a filter. | `components/OwnerChip.jsx` |

## Rules

| Use | For | Where |
| --- | --- | --- |
| `RuleForm` | Editing a rule. Its `AmountCondition` is the amount-range control for any other surface. | `components/RuleForm.jsx` |
| `RuleActionModal` | Creating a rule from a transaction, or opening the one that matches it. | `components/RuleActionModal.jsx` |
| `RuleSummary` | Showing one rule read-only. | `components/RuleSummary.jsx` |
| `RuleSuggestionToast` | Offering a rule after a manual category change. `TransactionListTable` mounts it, so only a surface that draws its own `CategoryCell` adds one. | `components/RuleSuggestionToast.jsx` |
| `RecategorizeControl` | The control that re-runs categorization. | `components/RecategorizeControl.jsx` |

## Documents, purchases and reimbursements

| Use | For | Where |
| --- | --- | --- |
| `DocumentsPanel` | The documents attached to one transaction. | `components/DocumentsPanel.jsx` |
| `DocumentAttachTarget` | Adding a document by paste, drop or browse. | `components/DocumentAttachTarget.jsx` |
| `DocumentList` | A list of documents with open, rename, edit, detach and delete. | `components/DocumentList.jsx` |
| `DocumentViewerDialog` | Viewing one document. | `components/DocumentViewerDialog.jsx` |
| `useStoredDocuments` | The list of stored documents. Mount it once for a page or panel, not in each row. | `lib/useStoredDocuments.js` |
| `PurchaseEditorDialog` | Editing a multi-payment purchase, from any surface that shows one of its payments. | `components/PurchaseEditorDialog.jsx` |
| `lib/purchaseLinks.js` | Deciding how rows group into a purchase, and wording a row's purchase marker. | `lib/purchaseLinks.js` |
| `ClaimPortionPicker` | Choosing how much of a transaction a reimbursement claims. | `components/ClaimPortionPicker.jsx` |

## Import and connections

| Use | For | Where |
| --- | --- | --- |
| `AccountMatchSelect` | Choosing which existing account a source account maps to. | `components/importExport/AccountMatchSelect.jsx` |
| `ImportNewAccountFields` | The name and type fields for an account created while mapping. | `components/ImportNewAccountFields.jsx` |
| `SourceAccountChip` / `OutcomeChip` | Reporting what each source account contributed to one import or sync. | `components/importExport/SourceAccountChip.jsx` |
| `LastSyncSummary` / `StatusPill` | Reporting a connection's last sync. | `components/connections/ConnectionStatus.jsx` |
| `providerSummaryLine` | The one-line status in a provider card's header. | `lib/connectionSummary.js` |
| `useConnectionOperations` | Anything done to a connection other than configuring it: sync, fetch more history, refresh accounts, remove synced transactions. It owns the vault gating. | `lib/useConnectionOperations.js` |
| `AccountIdentityPrompt` | Asking whether two accounts are the same real-world account. | `components/importExport/AccountIdentityPrompt.jsx` |
| `EditedTransactionsWarning` | Listing the manually edited rows a removal would delete. | `components/EditedTransactionsWarning.jsx` |

## Vault

| Use | For | Where |
| --- | --- | --- |
| `useVaultGate` | Any action that needs the vault unlocked: `await ensureVault()` first, and the action resumes once the vault opens. | `lib/useVaultGate.js` |
| `VaultPassphraseDialog` | The prompt a host renders for `useVaultGate`. Pass `onUnlockedByPasskey`, or a user with a passkey is offered only the passphrase. | `components/VaultPassphraseDialog.jsx` |
| `useVaultPasskeyUnlock` | An "Unlock with a passkey" control. | `lib/useVaultPasskeyUnlock.js` |
| `vaultPasskey.js` | The passkey ceremony (`registerPasskey`, `runVaultPasskeyUnlock`, `hasUsableVaultPasskey`). It answers `{ ok, reason }`, and a caller shows every reason, cancellation included. | `lib/vaultPasskey.js` |
| `RecoveryCodeReveal` | Showing a recovery code that will not be shown again. | `components/VaultRecoveryDialog.jsx` |

## Help, preferences and storage

| Use | For | Where |
| --- | --- | --- |
| Help registry + `FeatureExplainer` / `ContextualExplainer` / `HelpLink` | In-app help: a topic in the registry, a `?` beside what it explains, and a tip for a recognized situation. | `help/content.jsx`, `help/FeatureExplainer.jsx`, `help/ContextualExplainer.jsx`, `help/HelpLink.jsx` |
| `useUserPreference` | A UI preference kept per user. | `lib/UserPreferencesContext.jsx` |
| `localStore` / `sessionStore` | Browser storage, because a bare `window.localStorage` throws where the browser blocks site data. | `lib/browserStorage.js` |
| `downloadUrl` | Saving a file the server generates, so an error status reaches a handler. | `lib/api.js` |
| `saveBlob` | Saving content the app produced itself. | `lib/api.js` |

## What belongs here

An entry is a component built to be used by more than one surface: its name, when to reach for it, a
short reason where the choice is not obvious, and its path.

What does not belong: a component that serves a single surface, a description of how a component
works or what props it takes (its header comment says that), the history of how it came to be shared,
or a list of duplication not yet extracted.
