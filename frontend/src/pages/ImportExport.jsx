// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import React, { useCallback, useState, useEffect, useRef, useMemo } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api.js'
import { txnMutations } from '../lib/txnMutations.js'
import { useBusyIndicator } from '../lib/useBusyIndicator.js'
import { sniffAmazonExportKind } from '../lib/amazonDetect.js'
import { PaypalStatementImportDialog } from '../components/importExport/PaypalStatementImportDialog.jsx'
import { AmazonImportDialog } from '../components/importExport/AmazonImportDialog.jsx'
import AmazonSourcesSection from '../components/importExport/AmazonSourcesSection.jsx'
import {
  Card,
  PageHeader,
  Button,
  AppConfirmDialog,
  AppNoticeDialog,
  AppTextEntryDialog,
  OverlayBackdrop, LinkButton,
  FloatingPanelHeader, IconButton, DialogActions,
} from '../components/ui.jsx'
import { useImportedCategoryWorkspace } from '../contexts/ImportedCategoryWorkspaceContext.jsx'
import { getImportedCategoryWorkCounts } from '../lib/importExport/importedCategoryWork.js'
import ImportColumnMappingSection from '../components/ImportColumnMappingSection.jsx'
import ImportProfilesManager from '../components/ImportProfilesManager.jsx'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import StarterRulesDialog from '../components/StarterRulesDialog.jsx'
import {
  DataSourcePill,
  ImportedCategoryUsageInline,
} from '../components/importExport/importPresentational.jsx'
import { ImportErrorBoundary } from '../components/importExport/ImportErrorBoundary.jsx'
import { CONNECTIONS_ROUTE } from '../lib/connectionSummary.js'
import AccountMappingGrid from '../components/importExport/AccountMappingGrid.jsx'
import {
  DataSourceMismatchDialog,
  MultipleSourceMatchDialog,
  MultiFileSourceChooserDialog,
  CompatibleBatchAttachDialog,
} from '../components/importExport/importConfirmDialogs.jsx'
import { ImportedCategorySettingsDialog } from '../components/importExport/ImportedCategorySettingsDialog.jsx'
import { RawFilePreview } from '../components/importExport/RawFilePreview.jsx'
import { ImportUploadStage } from '../components/importExport/ImportUploadStage.jsx'
import WatchedFoldersPanel from '../components/importExport/WatchedFoldersPanel.jsx'
import { MoneyMovementReviewDialog } from '../components/importExport/MoneyMovementReviewDialog.jsx'
import { MoneyMovementTypeReportPanel } from '../components/importExport/MoneyMovementTypeReportPanel.jsx'
import { useBatchUndo } from '../components/importExport/useBatchUndo.jsx'
import { UndoToast } from '../components/CategoryTreePrimitives.jsx'
import { useBatchDetailPanels } from '../components/importExport/useBatchDetailPanels.jsx'
import { ImportHistorySection } from '../components/importExport/ImportHistorySection.jsx'
import { DataConnectionsPanel } from '../components/connections/DataConnectionsPanel.jsx'
import { useUnifiedDuplicatesViewer } from '../contexts/UnifiedDuplicatesViewerContext.jsx'
import { useSyncStatus } from '../contexts/SyncStatusContext.jsx'
import { useReconciliationViewer } from '../contexts/ReconciliationViewerContext.jsx'
import { buildDataSourceRows } from '../lib/importExport/dataSourceRows.js'
import {
  getBlankImportSnapshot,
  getBlankMappingSuggestions,
  stableSerialize,
  buildEmptyDataSourceBody,
  loadSavedImportDraftRecord,
  loadSavedImportDraft,
  saveImportDraft,
  clearSavedImportDraft,
  buildProfileBodyFromSnapshot,
  buildDraftRecordFromPreview,
  doesDraftMatchPreview,
  getSuggestedDataSourceName,
  profileHeaderClearlyMismatches,
  importColumnDelta,
  findProfilesMatchingPreview,
  groupFilesBySource,
  unionPreviewColumnValues,
  keepMappingsForAbsentColumns,
} from '../lib/importExport/importDraft.js'
import {
  summarizeImportOutcome,
  buildMultiFileResult,
  formatSkippedImportMessage,
} from '../lib/importExport/importOutcome.js'
import { countPendingRuleSuggestions, hasRuleSuggestionWork } from '../lib/importExport/ruleSuggestionWork.js'
import {
  analyzeImportColumns,
  computeEvidenceColumnOptions,
  DEFAULT_DECIMAL_SEPARATOR,
  defaultEvidenceColumns,
  forcedEvidenceColumns,
  formatLikelyMatchLabel,
  guessDecimalSeparatorForColumns,
  inferFilenamePattern,
  inferImportFileCharacteristicsFromPreview,
  inferUnambiguousImportMappingFromPreview,
} from '../lib/importColumnInference.js'
import ImportEvidenceColumnsSection from '../components/ImportEvidenceColumnsSection.jsx'
import { formatTransactionAmount, getTransactionAmountColor } from '../lib/moneyDisplay.js'
import { useAppSession } from '../lib/AppSessionContext.jsx'
import { useUserPreference } from '../lib/UserPreferencesContext.jsx'
import {
  IMPORT_DEFAULT_CATEGORY_USAGE_MODE_PREF_KEY,
  IMPORT_CATEGORY_USAGE_MODE_PER_SOURCE,
} from '../lib/appConfig.js'
import {
  AMOUNT_CONVENTIONS,
  DATE_FORMATS,
  DECIMAL_SEPARATORS,
  IMPORT_CONFIG_MAX_WIDTH,
  MANUAL_DATA_SOURCE_VALUE,
  EXPANDED_IMPORT_SOURCE_ROWS_PREF_KEY,
  IMPORTED_CATEGORY_SCOPE_FILTERED,
  IMPORTED_CATEGORY_SETTINGS_KEY,
  IMPORTED_CATEGORY_FILTER_DIALOG_TITLE,
  IMPORTED_CATEGORY_FILTER_DIALOG_DESCRIPTION,
} from '../lib/importExport/constants.js'
import {
  getBlankImportedCategorySettings,
  getDefaultImportedCategoryUsageEnabled,
  normalizeImportedCategorySettings,
  extractImportedCategorySettings,
  getFixedAccountCategoryScopeToken,
  getNewAccountCategoryScopeToken,
  summarizeImportedCategorySettings,
} from '../lib/importExport/importedCategorySettings.js'
import { mergePreviewAmounts, usePreviewAmounts } from '../lib/importExport/previewAmounts.js'
import { runImportWithProgress } from '../lib/importExport/importRunProgress.js'
import { sessionStore } from '../lib/browserStorage.js'
import {
  accountMappingProblem,
  defaultAccountMapEntry,
  findExactAccountNameMatch,
  findAccountMatchCandidates,
  findLikelyAccountMatch,
  buildAccountImportStateSnapshot,
} from '../lib/importExport/importAccountMatching.js'
import { formatCount } from '../lib/displayFormat.js'

// `UnifiedDuplicatesDialog` lives at the App level so it can stay open while the user navigates
// between Import, Accounts, Transactions, etc. — see
// `contexts/UnifiedDuplicatesViewerContext.jsx`. Open it via the `useUnifiedDuplicatesViewer`
// hook's `open({batchId, title})`.

// Custom dropdown that shows different text when closed vs open:
//   Closed (column mode):  "↔ Column  AccountName"
//   Closed (account mode): "AccountName ···mask"
//   Open list:             plain "AccountName" and plain "HeaderName" (no prefix)

// A PayPal monthly statement arrives as a PDF, or several in a zip; neither is a file the CSV importer
// could read, so the name decides where it goes and the statement import says what is in it.
function isPaypalStatementCandidate(file) {
  return /\.(pdf|zip)$/i.test(file?.name || '')
}

// The Import button's label while it runs: which file of a multi-file run, and how far through its rows.
function formatImportingLabel(fileProgress, rowProgress) {
  const rows = rowProgress ? `${formatCount(rowProgress.done)} / ${formatCount(rowProgress.total)}` : null
  if (fileProgress) {
    return rows
      ? `File ${fileProgress.current}/${fileProgress.total} · ${rows}…`
      : `Importing ${fileProgress.current}/${fileProgress.total}…`
  }
  return rows ? `Importing ${rows}…` : 'Importing…'
}

// Where an import in progress sits: above the page, the navigation pane and the floating reports, and
// beneath the mapping screen's own pickers (720) and every dialog it opens.
const IMPORT_IN_PROGRESS_Z_INDEX = 700

// Keep the import UI recoverable if a preview or mapping render crashes.
function ImportTab({ view, historyFocus, onShowHistory, onShowImport, onShowConnections }) {
  const navigate = useNavigate()
  const { dbInstanceId, preferenceSubjectId, demoLoaded } = useAppSession()
  const [defaultImportCategoryUsageMode] = useUserPreference(IMPORT_DEFAULT_CATEGORY_USAGE_MODE_PREF_KEY, IMPORT_CATEGORY_USAGE_MODE_PER_SOURCE)
  const [expandedSourceRows, setExpandedSourceRows] = useUserPreference(EXPANDED_IMPORT_SOURCE_ROWS_PREF_KEY, {})
  const [stage, setStage] = useState('upload')
  const [preview, setPreview] = useState(null)
  // Multi-file selection: the same-source group of files to import under the current mapping (the
  // representative file's preview drives the mapping stage; runImport loops these). Empty = the ordinary
  // single-file path, which falls back to [preview.file]. `multiSourceChoice` holds the grouped files
  // when a selection spans more than one data source, so the user can pick which source to import.
  const [importFiles, setImportFiles] = useState([])
  // Previews for every file in the current multi-file group (same order as importFiles). Needed so
  // account-column values that appear only in a *later* file still surface in the mapping UI and are
  // routed correctly — the union across these drives the account mapping, not just the first file.
  const [importFilePreviews, setImportFilePreviews] = useState([])
  const [multiSourceChoice, setMultiSourceChoice] = useState(null)
  const [multiImportProgress, setMultiImportProgress] = useState(null)
  // Rows done / total in the file importing right now, once its rows have started; drives the Import button.
  const [importRowProgress, setImportRowProgress] = useState(null)
  // After a PayPal import, the money-movement review: { batchId, proposals }. The user approves which
  // Type values route to the excluded Money movement category.
  const [moneyMovementReview, setMoneyMovementReview] = useState(null)
  // The per-Type drill-down report opened from the money-movement review's arrow (stacked over the dialog).
  const [moneyMovementReport, setMoneyMovementReport] = useState(null)
  const [moneyMovementApplying, setMoneyMovementApplying] = useState(false)
  // PayPal statements dropped on the importer, awaiting the statement import dialog.
  const [paypalStatementFiles, setPaypalStatementFiles] = useState(null)
  // AZAD Amazon exports dropped on the importer, for the Amazon import form they open.
  const [amazonFiles, setAmazonFiles] = useState(null)
  const [amazonSourceId, setAmazonSourceId] = useState(null)
  const [profiles, setProfiles] = useState([])
  const [accounts, setAccounts] = useState([])
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(false)
  const [batches, setBatches] = useState([])
  // A dropped file is matched and mapped against the saved sources and accounts, and both arrive with
  // the page's initial load — while the file input is usable from the first render. A file dropped before
  // that load settles is held here and handled by the effect beside handleDrop once it does. Handling it
  // at once would run the whole detect-and-apply chain inside the render it was dropped into, whose lists
  // are still empty, and the file would silently take a temporary draft even though its source exists.
  const [initialDataStatus, setInitialDataStatus] = useState('loading')
  const [filesAwaitingInitialData, setFilesAwaitingInitialData] = useState(null)
  const dropRef = useRef(null)
  const fileInputRef = useRef(null)
  const [selectedUploadSource, setSelectedUploadSource] = useState('')
  // The upload screen defaults to a plain drop zone that auto-detects the data source from the file.
  // `sourceChooserOpen` surfaces the explicit data-source picker instead — opened from "Start over",
  // the upload-screen "Choose a data source" link, or "Change". `pendingSourceMatchChoice` holds a
  // previewed file that matched more than one saved source until the user picks which to use.
  const [sourceChooserOpen, setSourceChooserOpen] = useState(false)
  const [pendingSourceMatchChoice, setPendingSourceMatchChoice] = useState(null)
  const [showUploadSourceCreate, setShowUploadSourceCreate] = useState(false)
  const [uploadSourceDraftName, setUploadSourceDraftName] = useState('')
  const [creatingUploadSource, setCreatingUploadSource] = useState(false)
  const [showMappingSourceChooser, setShowMappingSourceChooser] = useState(false)
  const [mappingBaselineSnapshot, setMappingBaselineSnapshot] = useState('')
  const [pendingMappingBaselineCapture, setPendingMappingBaselineCapture] = useState(false)
  const [manualDraftRecord, setManualDraftRecord] = useState(null)
  const [showManualDraftSave, setShowManualDraftSave] = useState(false)
  const [manualDraftSaveName, setManualDraftSaveName] = useState('')
  // The "save as data source" prompt opens from two places with different commit intent: the import
  // config screen saves the *current* mapping and activates it; the history card saves the stored
  // draft record without activating. Captured when the prompt opens so the single dialog commits right.
  const [manualDraftSaveActivate, setManualDraftSaveActivate] = useState(false)
  const [manualDraftSaveUseCurrent, setManualDraftSaveUseCurrent] = useState(false)
  const [savingManualDraftSource, setSavingManualDraftSource] = useState(false)
  const [compatibleBatchPrompt, setCompatibleBatchPrompt] = useState(null)
  const [attachingCompatibleBatches, setAttachingCompatibleBatches] = useState(false)
  const [editingSourceNameKey, setEditingSourceNameKey] = useState('')
  const [sourceNameDraft, setSourceNameDraft] = useState('')

  const [selectedProfile, setSelectedProfile] = useState('')
  const [accountId, setAccountId] = useState('')
  const [dateFormat, setDateFormat] = useState('%m/%d/%Y')
  const [amtConv, setAmtConv] = useState('single_signed')
  const [decimalSeparator, setDecimalSeparator] = useState(DEFAULT_DECIMAL_SEPARATOR)
  const [skipRows, setSkipRows] = useState(0)
  const [applyCat, setApplyCat] = useState(true)
  // Per-source auto-enrich opt-in (default off): fold a trusted source's detail into existing rows it
  // duplicates. Mirrors applyCat's plumbing (snapshot, run config, profile save/load, reset).
  const [enrichFromSource, setEnrichFromSource] = useState(false)
  const [useImportedCategories, setUseImportedCategories] = useState(getDefaultImportedCategoryUsageEnabled(defaultImportCategoryUsageMode))
  const [importedCategorySettings, setImportedCategorySettings] = useState(getBlankImportedCategorySettings())
  const [showImportedCategorySettings, setShowImportedCategorySettings] = useState(false)
  const [batchImportedCategorySettingsDialog, setBatchImportedCategorySettingsDialog] = useState(null)
  const [colDate, setColDate] = useState(null)
  const [colAmount, setColAmount] = useState(null)
  const [colDebit, setColDebit] = useState(null)
  const [colCredit, setColCredit] = useState(null)
  const [colDir, setColDir] = useState(null)
  const [colDesc, setColDesc] = useState(null)
  const [colCategory, setColCategory] = useState(null)
  const [colNotes, setColNotes] = useState(null)
  const [colPending, setColPending] = useState(null)
  const [colCurrency, setColCurrency] = useState(null)
  const [colTransactionId, setColTransactionId] = useState(null)
  const [colAccount, setColAccount] = useState(null)
  // The user's resolved capture picks (headers), or null = "not yet resolved" → derive the default set
  // (keyword/shape-matched unmapped columns). getColumnMap sends the resolved list as evidence_columns.
  const [evidenceColumns, setEvidenceColumns] = useState(null)
  // Raw-file viewer "load more": the preview only carries the first 20 lines, so we read the rest from
  // the held File on demand and reveal a doubling window (20 → 40 → 80 …). null = not yet read in full.
  const [rawViewerAllLines, setRawViewerAllLines] = useState(null)
  const [rawViewerCount, setRawViewerCount] = useState(0)
  const [rawViewerLoadingMore, setRawViewerLoadingMore] = useState(false)
  const [mappingSuggestions, setMappingSuggestions] = useState(getBlankMappingSuggestions())
  const [singleAccountNew, setSingleAccountNew] = useState({ enabled: false, name: '', type: 'depository' })
  const [accountMap, setAccountMap] = useState({})
  const [categoryAssignments, setCategoryAssignments] = useState({})
  const [importResult, setImportResult] = useState(null)
  // Post-import categorization nudge: shown on the done screen when an import brought no categories and
  // the user hasn't started categorizing yet (no leaf categories). It self-suppresses once they engage.
  const [showStarterRules, setShowStarterRules] = useState(false)
  const [landedImport, setLandedImport] = useState(null)
  const [starterPromptDismissed, setStarterPromptDismissed] = useState(false)
  const [addingStarterCats, setAddingStarterCats] = useState(false)
  // While demo data is loaded (`demoLoaded`, from the session) the backend blocks imports; the upload
  // stage disables its drop target rather than letting the user try and hit a 409.
  // `demoLoadable` (empty tenant) surfaces the "Load demo data" offer here so it's reachable after a
  // skip or a clear, not only from first-run onboarding.
  const [demoLoadable, setDemoLoadable] = useState(false)
  const [loadingDemo, setLoadingDemo] = useState(false)
  const busyDemo = useBusyIndicator(loadingDemo)
  // Re-evaluate when the tenant's blank-slate status can have changed, not just on mount: `loadable`
  // means an untouched tenant (no data rows AND no configured source/connection — see is_demo_loadable),
  // so importing the first file, saving a data source, or undoing the last batch flips it. Keying off
  // both batches and saved-source counts re-fetches at those moments, so the "Load demo data" offer
  // disappears the moment the user engages instead of lingering until a reload. A connection added on
  // another page is picked up when this page remounts on navigation.
  useEffect(() => {
    let cancelled = false
    api.getDemoDataStatus().then(r => {
      if (!cancelled) setDemoLoadable(!!r?.loadable)
    }).catch(() => { })
    return () => { cancelled = true }
  }, [batches.length, profiles.length])

  async function loadDemoFromImport() {
    setLoadingDemo(true)
    try {
      await api.loadDemoData()
      // Reload into a populated app (dashboard + demo banner); every page re-bootstraps with the data.
      window.location.assign('/')
    } catch (err) {
      setLoadingDemo(false)
      setNoticeDialog({ title: 'Could not load demo data', description: err?.message || 'Please try again.' })
    }
  }
  const [showRaw, setShowRaw] = useState(false)
  // Unified duplicates viewer state was lifted to UnifiedDuplicatesViewerContext so the floating
  // report can survive route changes. We hold onto the context handles here to open it and to
  // know when it has reloaded (so the file-card pill counts can be refreshed in step).
  const unifiedDuplicatesViewer = useUnifiedDuplicatesViewer()
  const reconciliationViewer = useReconciliationViewer()
  // Shared per-batch file-ledger panels (the `↗`). This tab keeps its own drill-through / URL openers
  // below, which call `openBatchDetail`.
  const { openBatchDetail, panelsNode } = useBatchDetailPanels({
    categories,
    onAddCategory: category => setCategories(prev => prev.some(existing => existing.id === category.id) ? prev : [...prev, category]),
    // Reconcile the file card's "N to review" pill when the batch-detail panel reports how many rows
    // still need review after the user categorized/reviewed some inside it.
    onReviewCountChange: (batchId, count) => setBatches(prev => prev.map(batch => (
      batch.id === batchId && batch.needs_review_count !== count ? { ...batch, needs_review_count: count } : batch
    ))),
  })
  const [pendingProfileMismatch, setPendingProfileMismatch] = useState(null)
  const [showProfileMismatchChooser, setShowProfileMismatchChooser] = useState(false)
  const [pendingMappingSourceSwitch, setPendingMappingSourceSwitch] = useState(null)
  const [noticeDialog, setNoticeDialog] = useState(null)
  const [reviewUndo, setReviewUndo] = useState(null)
  // Per-batch "+ New data source from this file" inline name entry (unknown-source cards).
  const [assignNewSourceBatchId, setAssignNewSourceBatchId] = useState('')
  const [assignNewSourceName, setAssignNewSourceName] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [dateFormatLocked, setDateFormatLocked] = useState(false)
  const [decimalSeparatorLocked, setDecimalSeparatorLocked] = useState(false)

  useEffect(() => {
    Promise.all([
      api.getImportProfiles(),
      // include_children so a CSV value whose original account has been grouped under
      // another (e.g. "Northgate Checking 1234" attached to "Northgate") still appears for the
      // exact-name and stem-match lookups below — otherwise the prior mapping silently
      // disappears the moment the user groups accounts on the Accounts page.
      api.getAccounts({ include_children: true }),
      api.getCategories(),
      api.listBatches(),
    ]).then(([p, a, c, b]) => {
      setProfiles(p)
      setAccounts(a)
      setCategories(c)
      setBatches(b)
      setInitialDataStatus('ready')
    }).catch(() => setInitialDataStatus('failed'))
  }, [])

  useEffect(() => {
    setManualDraftRecord(loadSavedImportDraftRecord(dbInstanceId, preferenceSubjectId))
  }, [dbInstanceId, preferenceSubjectId])

  // The Group Imported Categories workspace is App-level and can apply from another page; refresh our
  // own categories copy when it does so the file-card counts and category mapping stay current.
  useEffect(() => {
    function onCategoriesChanged() {
      api.getCategories().then(setCategories).catch(() => { })
    }
    window.addEventListener('luma:categories-changed', onCategoriesChanged)
    return () => window.removeEventListener('luma:categories-changed', onCategoriesChanged)
  }, [])

  const activeUploadProfile = useMemo(
    () => profiles.find(p => p.id === selectedUploadSource) || null,
    [profiles, selectedUploadSource]
  )
  const uploadUsesManualDraft = selectedUploadSource === MANUAL_DATA_SOURCE_VALUE
  const hasSelectedUploadSource = !!selectedUploadSource
  const uploadSelectionLabel = activeUploadProfile?.name || (uploadUsesManualDraft ? 'Temporary draft' : '')
  // The Group Imported Categories workspace is App-level now (ImportedCategoryWorkspaceContext); this
  // page only needs the opener and the count for its file-card button. The count comes from this page's
  // own categories + the shared draft (owned by the App-level workspace context, backed by shared
  // tenant state) so the badge is live before the workspace is ever opened.
  const { open: openSystemCategoryWorkspace, draft: systemCategoryWorkspaceDraft } = useImportedCategoryWorkspace()
  const { pending: pendingSystemCategoryCount, total: totalSystemCategoryWorkspaceCount } =
    getImportedCategoryWorkCounts(categories, systemCategoryWorkspaceDraft)
  const hasSystemRuleSuggestionWork = useMemo(() => hasRuleSuggestionWork(batches), [batches])
  // A leaf category means the user has already started categorizing (starter set, imported categories,
  // or their own), so the post-import starter nudge stops appearing.
  const hasAnyLeafCategory = useMemo(() => categories.some(category => category.parent_id), [categories])
  const pendingSystemRuleSuggestionCount = useMemo(() => countPendingRuleSuggestions(batches), [batches])

  // Also invoked by the App-level duplicate-detection dialog's drill-through arrow — through
  // the viewer-context drill-through registration in the effect below (when ImportExport is
  // mounted), or via a URL-param fallback (the effect after that) when it isn't.
  // Register an in-place drill-through handler with the App-level duplicates viewer. While
  // we're mounted, clicking the source-batch link inside the floating dialog opens the batch
  // detail panel here without a URL navigation. When we unmount, the context falls back to
  // navigating to `/import-export?openBatch=…` so the same action still works from any page.
  useEffect(() => {
    return unifiedDuplicatesViewer.registerDrillThroughHandler(({ batchId: targetBatchId, dateStart, dateEnd }) => {
      const sourceBatch = batches.find(b => b.id === targetBatchId)
      if (!sourceBatch) return
      const _dateFilter = (dateStart || dateEnd) ? { dateStart, dateEnd } : undefined
      openBatchDetail({ ...sourceBatch, _dateFilter })
    })
  }, [unifiedDuplicatesViewer, batches, openBatchDetail])

  // Drill-through fallback: when the user is on another page and clicks the source-batch link,
  // the context navigates here with these query params. Honor them once on arrival, then clean
  // the URL so a later refresh doesn't re-open the panel.
  const location = useLocation()
  useEffect(() => {
    if (!batches.length) return
    const params = new URLSearchParams(location.search)
    const targetBatchId = params.get('openBatch')
    if (!targetBatchId) return
    const sourceBatch = batches.find(b => b.id === targetBatchId)
    if (sourceBatch) {
      const dateStart = params.get('dateStart') || ''
      const dateEnd = params.get('dateEnd') || ''
      const _dateFilter = (dateStart || dateEnd) ? { dateStart, dateEnd } : undefined
      openBatchDetail({ ...sourceBatch, _dateFilter })
    }
    navigate('/import-export', { replace: true })
    // Arriving for one card means the history is the page behind its ledger, with that card marked.
    if (sourceBatch) onShowHistory({ batchIds: [targetBatchId] })
  }, [location.search, batches, navigate, openBatchDetail, onShowHistory])

  // `?review=wallet&account=<id>` is a wallet account's Tasks entry's way into its reconciliation, which is
  // about the account's whole history rather than one file. Honored once on arrival, then cleaned from the
  // URL like the one above.
  const openReconciliation = reconciliationViewer.open
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    if (params.get('review') !== 'wallet') return
    openReconciliation({ vendor: 'wallet', walletId: params.get('account') || undefined, title: '' })
    navigate('/import-export', { replace: true })
  }, [location.search, navigate, openReconciliation])

  // When the user resolves rows from the floating dialog, the file-card pill counts on this
  // page need to refresh so the displayed numbers stay honest. The context advances
  // `viewer.data.version` on every load — opening the report included, which is what lets a pill that
  // has gone stale correct itself when the user clicks it — and we watch that counter (only when
  // mounted) and re-fetch the batch list when it changes. 0 means no report has loaded at all.
  const viewerVersion = unifiedDuplicatesViewer.viewer?.data?.version || 0
  useEffect(() => {
    if (viewerVersion === 0) return
    api.listBatches().then(setBatches).catch(() => { })
  }, [viewerVersion])

  // Same idea for the reconciliation reports: resolving items there changes a batch's "N to resolve"
  // count (recomputed in listBatches), so refresh the data-sources cards when a report loads.
  const reconVersion = reconciliationViewer.viewer?.data?.version || 0
  useEffect(() => {
    if (reconVersion === 0) return
    api.listBatches().then(setBatches).catch(() => { })
  }, [reconVersion])

  // And when a sync run ends, wherever it was started: a sync writes onto this page's connection cards and
  // moves their "Last synced", and a history loaded before it finished would otherwise go on showing the
  // counts from that moment — rows already landed beside chips and totals that had not been written yet.
  // Keyed to the count seen at mount, so arriving here after earlier runs does not repeat the initial load.
  const { runsFinished, refreshConnections } = useSyncStatus()
  const handledRunsRef = useRef(runsFinished)
  useEffect(() => {
    if (runsFinished === handledRunsRef.current) return
    handledRunsRef.current = runsFinished
    api.listBatches().then(setBatches).catch(() => { })
  }, [runsFinished])
  // For a change to the cards that no sync run reports (a connection's synced transactions removed).
  const refreshBatches = useCallback(() => api.listBatches().then(setBatches).catch(() => { }), [])
  // A connection renamed from its history heading: the cards and every connection listing re-read, so the
  // new name reaches the connections card above as well. A failure stays with the editor.
  const renameConnection = useCallback(async (connectionId, name) => {
    await api.setConnectionNickname(connectionId, name)
    await Promise.all([refreshBatches(), refreshConnections()])
  }, [refreshBatches, refreshConnections])

  // Choosing a source (explicitly from the picker, or resolved by auto-detect) settles the upload
  // screen back to the drop zone with that source applied.
  function selectUploadSource(nextSourceId) {
    setSelectedUploadSource(nextSourceId)
    setSourceChooserOpen(false)
  }

  function getSourceNameEditKey(location, profileId) {
    return `${location}:${profileId || ''}`
  }

  // Drop a selected source that no longer exists (e.g. deleted in the data-source manager).
  useEffect(() => {
    if (!selectedUploadSource || selectedUploadSource === MANUAL_DATA_SOURCE_VALUE) return
    if (!profiles.some(profile => profile.id === selectedUploadSource)) {
      setSelectedUploadSource('')
    }
  }, [profiles, selectedUploadSource])

  // Memoized so the data-source manager's `refreshManagerData` (which depends on this via `onDataChange`)
  // keeps a stable identity — otherwise its load effect re-fires on every parent render, which the manager
  // triggers by calling back here, and the two ping-pong into an infinite accounts/batches/profiles
  // refetch loop. setState functions are stable, so `[]` deps are correct.
  const handleManagerDataChange = useCallback(({ profiles: nextProfiles, accounts: nextAccounts, batches: nextBatches } = {}) => {
    if (Array.isArray(nextProfiles)) setProfiles(nextProfiles)
    // Saving a data source can create its account, and the source is applied here right afterwards.
    if (Array.isArray(nextAccounts)) setAccounts(nextAccounts)
    if (Array.isArray(nextBatches)) setBatches(nextBatches)
  }, [])

  // Every file being imported under the current mapping: the multi-file group when there is one, else
  // just the single previewed file. The account-column mapping unions across all of them so no value is
  // missed when it only appears in a non-first file.
  const importGroupPreviews = useMemo(
    () => (importFilePreviews.length ? importFilePreviews : (preview ? [preview] : [])),
    [importFilePreviews, preview],
  )
  const accountValuesUnion = useMemo(
    () => unionPreviewColumnValues(importGroupPreviews, colAccount),
    [colAccount, importGroupPreviews],
  )
  const distinctAccountValues = accountValuesUnion.values
  const accountValueCounts = accountValuesUnion.counts

  // Distinct new accounts the user has chosen to create in THIS import (deduped by name). Offered
  // as targets in every other label's picker so several file labels can collapse onto one new
  // account. There is no label-to-label reference — each label independently declares the name —
  // so re-pointing one label never dangles another; the importer merges same-named new accounts.
  const inFlightNewAccounts = useMemo(() => {
    const byName = new Map()
    for (const entry of Object.values(accountMap || {})) {
      if (!entry?.createNew || entry?.skip) continue
      const name = String(entry.newName || '').trim()
      if (name && !byName.has(name.toLowerCase())) {
        byName.set(name.toLowerCase(), { name, type: entry.newType || '' })
      }
    }
    return [...byName.values()]
  }, [accountMap])

  const previousImportAccounts = useMemo(
    () => (preview?.previous_batch_accounts || []).filter(a => !a.was_skipped),
    [preview],
  )
  const previousImportAccountsByValue = useMemo(
    () => new Map(previousImportAccounts.filter(a => a.csv_value).map(a => [a.csv_value, a])),
    [previousImportAccounts],
  )
  const remainingAccountValues = useMemo(
    () => distinctAccountValues.filter(value => !previousImportAccountsByValue.has(value)),
    [distinctAccountValues, previousImportAccountsByValue],
  )
  // Every account each unmapped CSV value could already be, plus the one (if any) confident enough for
  // the row's one-click accept chip. Both come from the matcher rather than the row deriving the second
  // from the first: "chip-worthy" needs exactly one possibility AND name evidence, and a row reasoning
  // "the list has one entry" would offer one-click accepts on mask look-alikes.
  const accountMatchesByValue = useMemo(
    () => Object.fromEntries(remainingAccountValues.map(value => [value, {
      candidates: findAccountMatchCandidates(accounts, value),
      likely: findLikelyAccountMatch(accounts, value),
    }])),
    [remainingAccountValues, accounts],
  )
  const importableRowCount = useMemo(() => {
    if (!preview) return 0
    const baseRowCount = Math.max(0, Number(preview.total_rows || 0) - skipRows)
    if (!colAccount) {
      return preview.previous_batch ? 0 : baseRowCount
    }
    const alreadyImportedRows = previousImportAccounts.reduce(
      (total, item) => total + Number(item?.row_count || 0),
      0,
    )
    const skippedAccountRows = remainingAccountValues.reduce((total, value) => {
      const mapping = accountMap[value]
      if (!mapping?.skip) return total
      return total + Number(accountValueCounts[value] || 0)
    }, 0)
    return Math.max(0, baseRowCount - alreadyImportedRows - skippedAccountRows)
  }, [preview, skipRows, colAccount, previousImportAccounts, remainingAccountValues, accountMap, accountValueCounts])

  const importedCategoryChoices = useMemo(() => {
    const ownerChoices = new Map()
    const unassignedChoices = new Map()
    const addOwnerChoice = (ownerId, ownerName, rowCount = 0) => {
      const normalizedId = String(ownerId || '').trim()
      if (!normalizedId) return
      const existing = ownerChoices.get(normalizedId)
      ownerChoices.set(normalizedId, {
        key: `owner:${normalizedId}`,
        kind: 'owner',
        ownerId: normalizedId,
        label: ownerName || 'Unnamed owner',
        rowCount: (existing?.rowCount || 0) + Number(rowCount || 0),
      })
    }
    const addUnassignedChoice = (token, label, rowCount = 0, sourceLabel = '') => {
      const normalizedToken = String(token || '').trim()
      if (!normalizedToken) return
      const existing = unassignedChoices.get(normalizedToken)
      unassignedChoices.set(normalizedToken, {
        key: `account:${normalizedToken}`,
        kind: 'account',
        token: normalizedToken,
        label,
        sourceLabel: existing?.sourceLabel || sourceLabel,
        rowCount: (existing?.rowCount || 0) + Number(rowCount || 0),
      })
    }

    if (colAccount) {
      for (const csvVal of remainingAccountValues) {
        const mapping = accountMap[csvVal]
        if (mapping?.skip) continue
        const rowCount = Number(accountValueCounts[csvVal] || 0)
        if (mapping?.accountId) {
          const account = accounts.find(item => item.id === mapping.accountId)
          if (account?.owner_id) addOwnerChoice(account.owner_id, account.owner_name || account.name, rowCount)
          else addUnassignedChoice(csvVal, account?.name || csvVal, rowCount, csvVal)
          continue
        }
        if (mapping?.createNew && String(mapping.newName || '').trim()) {
          addUnassignedChoice(csvVal, String(mapping.newName || csvVal).trim(), rowCount, csvVal)
        }
      }
    } else if (singleAccountNew.enabled && singleAccountNew.name.trim()) {
      addUnassignedChoice(getNewAccountCategoryScopeToken(singleAccountNew.name), singleAccountNew.name.trim(), importableRowCount)
    } else if (accountId) {
      const account = accounts.find(item => item.id === accountId)
      if (account?.owner_id) addOwnerChoice(account.owner_id, account.owner_name || account.name, importableRowCount)
      else addUnassignedChoice(getFixedAccountCategoryScopeToken(accountId), account?.name || 'Selected account', importableRowCount)
    }

    return [
      ...Array.from(ownerChoices.values()).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })),
      ...Array.from(unassignedChoices.values()).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })),
    ]
  }, [
    accountId,
    accountMap,
    accountValueCounts,
    accounts,
    colAccount,
    importableRowCount,
    remainingAccountValues,
    singleAccountNew,
  ])
  const importedCategorySummary = useMemo(
    () => summarizeImportedCategorySettings(importedCategorySettings, importedCategoryChoices),
    [importedCategoryChoices, importedCategorySettings],
  )

  useEffect(() => {
    setImportedCategorySettings(prev => {
      const normalized = normalizeImportedCategorySettings(prev)
      if (normalized.scope_mode !== IMPORTED_CATEGORY_SCOPE_FILTERED) return prev
      const validOwnerIds = new Set(importedCategoryChoices.filter(choice => choice.kind === 'owner').map(choice => choice.ownerId))
      const validAccountTokens = new Set(importedCategoryChoices.filter(choice => choice.kind === 'account').map(choice => choice.token))
      const nextSettings = {
        ...normalized,
        owner_ids: normalized.owner_ids.filter(ownerId => validOwnerIds.has(ownerId)),
        unassigned_account_tokens: normalized.unassigned_account_tokens.filter(token => validAccountTokens.has(token)),
      }
      return stableSerialize(nextSettings) === stableSerialize(normalized) ? prev : nextSettings
    })
  }, [importedCategoryChoices])

  // One component owns both the Data Import tab and the File Sources tab, because they are two views
  // of one state — the batch list, the saved sources, the temporary draft. `view` picks which is on
  // screen; the dialogs and floating reports below belong to both, and so does an import in progress,
  // which a new source's sample file starts from the File Sources tab.
  //
  // An import in progress is modal: from the mapping screen until it is imported or cancelled, the rest
  // of the app sits behind a scrim. Its state lives in this component, so a tab or a page chosen in the
  // middle of one would unmount it and throw the mapping away. The browser's own leave warning covers
  // the refresh and the closed tab, which a scrim cannot.
  const importInProgress = stage !== 'upload'
  useEffect(() => {
    if (!importInProgress) return
    const warn = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [importInProgress])
  const managerHostData = useMemo(
    () => ({ profiles, accounts, batches, loading: initialDataStatus === 'loading' }),
    [profiles, accounts, batches, initialDataStatus],
  )
  const dataSourceRows = useMemo(
    () => buildDataSourceRows({ profiles, batches, manualDraftRecord }),
    [profiles, batches, manualDraftRecord],
  )

  const columnAnalysis = useMemo(() => analyzeImportColumns(preview, skipRows), [preview, skipRows])

  // The capture panel: unmapped columns with an inferred shape + default. `resolvedEvidenceColumns` is
  // what actually gets captured — the user's explicit picks, or the derived default when untouched —
  // filtered to columns still present and unmapped so a stale pick can't leak through.
  const mappedHeaders = useMemo(
    () => [colDate, colAmount, colDebit, colCredit, colDir, colDesc, colCategory, colNotes, colPending, colCurrency, colTransactionId, colAccount].filter(Boolean),
    [colDate, colAmount, colDebit, colCredit, colDir, colDesc, colCategory, colNotes, colPending, colCurrency, colTransactionId, colAccount],
  )
  const evidenceColumnOptions = useMemo(
    () => computeEvidenceColumnOptions(preview, mappedHeaders, skipRows),
    [preview, mappedHeaders, skipRows],
  )
  const resolvedEvidenceColumns = useMemo(() => {
    const optionHeaders = new Set(evidenceColumnOptions.map(option => option.header))
    const base = evidenceColumns == null ? defaultEvidenceColumns(evidenceColumnOptions) : evidenceColumns
    return base.filter(header => optionHeaders.has(header))
  }, [evidenceColumns, evidenceColumnOptions])
  const forcedEvidenceCols = useMemo(
    () => forcedEvidenceColumns(preview, evidenceColumnOptions),
    [preview, evidenceColumnOptions],
  )

  // What this file's columns are doing that the applied data source has not seen. The source learns
  // the file's layout on a completed import, so this is the one screen on which a vendor's added
  // column can still be mapped or ticked for capture before it stops being news.
  const sourceColumnDelta = useMemo(
    () => importColumnDelta(profiles.find(p => p.id === selectedProfile), preview),
    [profiles, selectedProfile, preview],
  )

  const selectedDateAnalysis = colDate ? columnAnalysis.dateAnalysisByHeader[colDate] : null
  const selectedAmountAnalysis = colAmount ? columnAnalysis.amountAnalysisByHeader[colAmount] : null
  const sourceCategoryValues = useMemo(() => {
    if (!colCategory || !preview?.column_distinct_values) return []
    return (preview.column_distinct_values[colCategory] || []).filter(Boolean)
  }, [colCategory, preview])
  const sourceCategoryMeta = useMemo(() => {
    if (!colCategory || !preview?.column_distinct_meta) return null
    return preview.column_distinct_meta[colCategory] || null
  }, [colCategory, preview])
  const dateSelectHint = selectedDateAnalysis
    ? selectedDateAnalysis.guessedFormat
      ? `Detected ${DATE_FORMATS.find(option => option.value === selectedDateAnalysis.guessedFormat)?.label.split('  ')[0] || selectedDateAnalysis.guessedFormat}.`
      : selectedDateAnalysis.sampleCount
        ? 'Sample values in this column do not strongly look like dates.'
        : ''
    : columnAnalysis.dateCandidates.length > 0
      ? formatLikelyMatchLabel(columnAnalysis.dateCandidates.length)
      : ''

  const amountSelectHint = amtConv === 'two_column'
    ? null
    : selectedAmountAnalysis
      ? selectedAmountAnalysis.amountMatches > 0
        ? (selectedAmountAnalysis.guessedLabel || `${selectedAmountAnalysis.amountMatches}/${selectedAmountAnalysis.sampleCount || 0} sample value${selectedAmountAnalysis.amountMatches === 1 ? '' : 's'} look like amounts.`)
        : selectedAmountAnalysis.sampleCount
          ? 'Sample values in this column do not strongly look like amounts.'
          : ''
      : columnAnalysis.amountCandidates.length > 0
        ? formatLikelyMatchLabel(columnAnalysis.amountCandidates.length)
        : ''

  const categorySelectHint = columnAnalysis.categoryCandidates.length > 0 && !colCategory
    ? formatLikelyMatchLabel(columnAnalysis.categoryCandidates.length)
    : ''
  const accountSelectHint = columnAnalysis.accountCandidates.length > 0 && !colAccount && !accountId && !singleAccountNew.enabled
    ? formatLikelyMatchLabel(columnAnalysis.accountCandidates.length)
    : ''
  function clearMappingSuggestion(field) {
    setMappingSuggestions(prev => prev[field] ? { ...prev, [field]: '' } : prev)
  }

  function getCandidateFieldHint(candidateHeaders, currentValue) {
    return candidateHeaders.length > 0 && !currentValue
      ? formatLikelyMatchLabel(candidateHeaders.length)
      : ''
  }

  function buildMappingFieldConfig({
    key,
    label,
    candidateHeaders,
    value,
    setValue,
    required = false,
    hint = undefined,
    tone = 'muted',
    after = null,
    onChange = null,
    onAcceptSuggestion = null,
  }) {
    const defaultOnChange = nextValue => {
      if (nextValue) clearMappingSuggestion(key)
      setValue?.(nextValue)
    }
    const resolvedOnChange = onChange || defaultOnChange
    return {
      key,
      label,
      headers: candidateHeaders,
      allHeaders: preview.headers,
      value,
      onChange: resolvedOnChange,
      suggestedValue: mappingSuggestions[key],
      onAcceptSuggestion: onAcceptSuggestion || resolvedOnChange,
      required,
      hint: hint ?? getCandidateFieldHint(candidateHeaders, value),
      tone,
      after,
    }
  }

  function handleDateColumnChange(nextValue) {
    setDateFormatLocked(false)
    if (nextValue) clearMappingSuggestion('date')
    setColDate(nextValue)
  }

  function handleCategoryColumnChange(nextValue) {
    if (nextValue) clearMappingSuggestion('category')
    setColCategory(nextValue)
  }

  useEffect(() => {
    setAccountMap(prev => {
      const next = { ...prev }
      for (const val of distinctAccountValues) {
        const exactMatch = findExactAccountNameMatch(accounts, val)
        if (!(val in next)) {
          next[val] = {
            accountId: exactMatch ? exactMatch.id : '',
            createNew: false,
            newName: val,
            newType: exactMatch?.type || '',
            groupWithAccountId: '',
            skip: false,
          }
          continue
        }
        const entry = next[val] || {}
        if (
          exactMatch &&
          !entry.skip &&
          !entry.accountId &&
          (!entry.createNew || String(entry.newName || '').trim().toLowerCase() === String(val || '').trim().toLowerCase())
        ) {
          next[val] = {
            ...entry,
            accountId: exactMatch.id,
            createNew: false,
            newName: exactMatch.name || val,
            newType: exactMatch.type || entry.newType || 'depository',
            groupWithAccountId: '',
            skip: false,
          }
        }
      }
      for (const [csvVal, entry] of Object.entries(next)) {
        const stillExists = entry.accountId
          ? accounts.find(a => a.id === entry.accountId)
          : null
        if (entry.accountId && !stillExists) {
          const byName = findExactAccountNameMatch(accounts, csvVal)
          next[csvVal] = byName
            ? {
              ...entry,
              accountId: byName.id,
              createNew: false,
              newName: byName.name,
              newType: byName.type || entry.newType || 'depository',
              groupWithAccountId: '',
              skip: false,
            }
            : {
              accountId: '',
              createNew: false,
              newName: csvVal,
              newType: entry.newType || '',
              groupWithAccountId: '',
              skip: false,
            }
        }
        if (entry.createNew && entry.newName && !accounts.some(a => a.name.toLowerCase() === entry.newName.trim().toLowerCase()) && entry.newName !== csvVal) {
          next[csvVal] = {
            accountId: '',
            createNew: false,
            newName: csvVal,
            newType: entry.newType || '',
            groupWithAccountId: '',
            skip: false,
          }
        }
        if (entry.groupWithAccountId && !accounts.some(a => a.id === entry.groupWithAccountId)) {
          next[csvVal] = {
            ...next[csvVal],
            groupWithAccountId: '',
          }
        }
      }
      return next
    })
  }, [distinctAccountValues, accounts])

  const hasImportWorkToSave = !!(
    colDate || colAmount || colDebit || colCredit || colDir || colDesc || colCategory || colNotes || colPending || colCurrency || colTransactionId ||
    colAccount || accountId || singleAccountNew.enabled || Object.keys(accountMap).length > 0 ||
    Object.keys(categoryAssignments).length > 0 || skipRows > 0 || dateFormat !== '%m/%d/%Y' ||
    amtConv !== 'single_signed' || decimalSeparator !== DEFAULT_DECIMAL_SEPARATOR || !applyCat || useImportedCategories ||
    stableSerialize(importedCategorySettings) !== stableSerialize(getBlankImportedCategorySettings())
  )

  useEffect(() => {
    if (!preview || !hasImportWorkToSave || selectedProfile) return
    const savedRecord = saveImportDraft(preview, buildImportSnapshot(), dbInstanceId, preferenceSubjectId)
    setManualDraftRecord(savedRecord || loadSavedImportDraftRecord(dbInstanceId, preferenceSubjectId))
    // buildImportSnapshot is useCallback'd (declared further down in this file)
    // with the exact state deps enumerated here, so its identity invalidates at
    // the same moments this effect would. Listing it here would require moving
    // its declaration above this point — left for a future reorganization pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    dbInstanceId, preferenceSubjectId,
    preview, hasImportWorkToSave, selectedProfile, accountId, dateFormat, amtConv, decimalSeparator, skipRows, applyCat, useImportedCategories, importedCategorySettings,
    colDate, colAmount, colDebit, colCredit, colDir, colDesc, colCategory, colNotes, colPending, colCurrency, colTransactionId, colAccount,
    singleAccountNew, accountMap, categoryAssignments,
  ])

  useEffect(() => {
    if (!colDate || dateFormatLocked) return
    const guessedFormat = columnAnalysis.dateAnalysisByHeader[colDate]?.guessedFormat
    if (guessedFormat && guessedFormat !== dateFormat) {
      setDateFormat(guessedFormat)
    }
  }, [colDate, columnAnalysis.dateAnalysisByHeader, dateFormat, dateFormatLocked])

  // Like the date format: suggested from the mapped amount columns until someone picks it, or a saved
  // source or snapshot states it.
  useEffect(() => {
    if (decimalSeparatorLocked) return
    const guessed = guessDecimalSeparatorForColumns(preview, [colAmount, colDebit, colCredit], skipRows)
    if (guessed && guessed !== decimalSeparator) setDecimalSeparator(guessed)
  }, [preview, colAmount, colDebit, colCredit, skipRows, decimalSeparator, decimalSeparatorLocked])

  const previewSourceRows = useMemo(
    () => (preview?.rows ? preview.rows.slice(skipRows) : []),
    [preview?.rows, skipRows],
  )

  // Amounts are parsed by the backend, not here — see lib/importExport/previewAmounts.js for why the
  // client owns no amount parsing.
  const previewAmounts = usePreviewAmounts({
    rows: previewSourceRows,
    amountConvention: amtConv,
    decimalSeparator,
    columnMap: { amount: colAmount, debit: colDebit, credit: colCredit, direction: colDir },
  })

  function computePreviewRows() {
    return previewSourceRows.map((row, i) => ({
      i,
      rawDate: colDate ? String(row[colDate] ?? '').trim() : null,
      rawDesc: colDesc ? String(row[colDesc] ?? '').trim() : null,
      rawCat: colCategory ? String(row[colCategory] ?? '').trim() : null,
      rawAcct: colAccount ? String(row[colAccount] ?? '').trim() : null,
      // Kept client-side: the unparseable marker shows the cell as the file wrote it, and only the
      // single-amount-column conventions have one cell to show.
      rawAmountStr: amtConv !== 'two_column' && colAmount ? String(row[colAmount] ?? '') : null,
      amount: null,
    }))
  }
  const previewRows = mergePreviewAmounts(computePreviewRows(), previewAmounts)
  const detectedHeaderOffset = preview?.header_row_index ?? 0
  const headerDetectedBeyondFirstLine = detectedHeaderOffset > 0
  const displayedSkipRows = skipRows + detectedHeaderOffset
  const showTrailingDataWarning = !!importResult?.trailing_non_transaction_suspected
  const showInvalidDataWarning = !!importResult?.invalid_rows_suspected
  // Default mode shows the raw file from the top and supports "load more"; the tail/invalid modes are
  // targeted windows, so they keep their fixed line sets.
  const isDefaultRawMode = !showTrailingDataWarning && !showInvalidDataWarning
  const defaultRawLines = rawViewerAllLines
    ? rawViewerAllLines.slice(0, rawViewerCount || rawViewerAllLines.length)
    : preview?.raw_lines
  const rawViewerLines = showTrailingDataWarning
    ? (preview?.raw_tail_lines?.length ? preview.raw_tail_lines : preview?.raw_lines)
    : showInvalidDataWarning
      ? (importResult?.invalid_row_context_lines?.length ? importResult.invalid_row_context_lines : preview?.raw_lines)
      : defaultRawLines
  // The footer is present whenever the file carries more than the preview's lines (stable through the
  // whole load sequence, so it never vanishes mid-interaction); the button is active only while more
  // remains, otherwise the footer shows "All lines shown".
  const rawViewerSupportsLoadMore = isDefaultRawMode && !!preview?.file
    && (preview?.total_rows || 0) > (preview?.raw_lines?.length || 0)
  const rawViewerCanLoadMore = rawViewerAllLines
    ? rawViewerCount < rawViewerAllLines.length
    : true
  const rawViewerOffset = showTrailingDataWarning && preview?.raw_tail_lines?.length
    ? (preview.raw_tail_start_line ?? 0)
    : showInvalidDataWarning
      ? (importResult?.invalid_row_context_start_line ?? 0)
      : 0
  const rawViewerTitle = showTrailingDataWarning
    ? 'File tail'
    : showInvalidDataWarning
      ? 'Invalid rows'
      : 'Raw file'
  const rawViewerNote = showTrailingDataWarning
    ? (importResult?.trailing_non_transaction_message || 'There appears to be non-transaction data at the end of the file. Please verify the file tail.')
    : showInvalidDataWarning
      ? (importResult?.invalid_rows_message || 'There appears to be invalid data in the file. Please verify the highlighted rows.')
      : null

  // Reset the raw-viewer "load more" window whenever the previewed file changes.
  useEffect(() => {
    setRawViewerAllLines(null)
    setRawViewerCount(preview?.raw_lines?.length || 0)
    setRawViewerLoadingMore(false)
  }, [preview?.file_content_hash, preview?.raw_lines?.length])

  async function loadMoreRawLines() {
    let all = rawViewerAllLines
    if (!all) {
      if (!preview?.file) return
      setRawViewerLoadingMore(true)
      try {
        const text = await preview.file.text()
        all = text.split(/\r\n|\r|\n/)
        // Drop a single trailing empty element from a final newline so the count matches the file.
        if (all.length && all[all.length - 1] === '') all = all.slice(0, -1)
        setRawViewerAllLines(all)
      } catch {
        setRawViewerLoadingMore(false)
        return
      }
      setRawViewerLoadingMore(false)
    }
    const base = rawViewerCount || preview?.raw_lines?.length || all.length
    setRawViewerCount(Math.min(all.length, Math.max(base, 1) * 2))
  }

  const buildImportSnapshot = useCallback(() => {
    // getColumnMap is a hoisted function declaration so it stays callable from
    // here despite this being a useCallback above its source position. We list
    // every column state var explicitly in the deps below so a column-mapping
    // change still invalidates the snapshot.
    const cm = getColumnMap()
    const accountImportState = buildAccountImportStateSnapshot(accountMap)
    if (!colAccount && singleAccountNew.enabled && singleAccountNew.name.trim()) {
      const snapshot = {
        column_map: {
          ...cm,
          single_account_new: { name: singleAccountNew.name.trim(), type: singleAccountNew.type || 'depository' },
          [IMPORTED_CATEGORY_SETTINGS_KEY]: normalizeImportedCategorySettings(importedCategorySettings),
        },
        account_id: null,
        single_account_new: { name: singleAccountNew.name.trim(), type: singleAccountNew.type || 'depository' },
        date_format: dateFormat,
        amount_convention: amtConv,
        decimal_separator: decimalSeparator,
        skip_rows: skipRows,
        apply_categorization: applyCat,
        enrich_from_source: enrichFromSource,
        use_imported_categories: useImportedCategories && !!colCategory,
        imported_category_scope_mode: normalizeImportedCategorySettings(importedCategorySettings).scope_mode,
        imported_category_owner_ids: normalizeImportedCategorySettings(importedCategorySettings).owner_ids,
        imported_category_unassigned_account_tokens: normalizeImportedCategorySettings(importedCategorySettings).unassigned_account_tokens,
        ...accountImportState,
      }
      return snapshot
    }
    const normalizedImportedCategorySettings = normalizeImportedCategorySettings(importedCategorySettings)
    const snapshot = {
      column_map: { ...cm, [IMPORTED_CATEGORY_SETTINGS_KEY]: normalizedImportedCategorySettings },
      account_id: (!colAccount && accountId) ? accountId : null,
      date_format: dateFormat,
      amount_convention: amtConv,
      decimal_separator: decimalSeparator,
      skip_rows: skipRows,
      apply_categorization: applyCat,
      enrich_from_source: enrichFromSource,
      use_imported_categories: useImportedCategories && !!colCategory,
      imported_category_scope_mode: normalizedImportedCategorySettings.scope_mode,
      imported_category_owner_ids: normalizedImportedCategorySettings.owner_ids,
      imported_category_unassigned_account_tokens: normalizedImportedCategorySettings.unassigned_account_tokens,
      ...accountImportState,
    }
    return snapshot
    // getColumnMap is a hoisted function declaration (further down in this file) that
    // reads exactly the col* state vars listed below, so the effective dependency set
    // is captured. Listing getColumnMap directly would require moving its declaration
    // above this point (or useCallback'ing it, which would TDZ here).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    accountMap, accountId, dateFormat, amtConv, decimalSeparator, skipRows,
    applyCat, enrichFromSource, useImportedCategories, importedCategorySettings, singleAccountNew,
    colDate, colAmount, colDebit, colCredit, colDir, colDesc, colCategory, colNotes, colPending, colCurrency, colTransactionId, colAccount,
    resolvedEvidenceColumns,
  ])

  function buildCurrentManualDraftRecord(previewLike = preview) {
    if (!previewLike) return null
    return buildDraftRecordFromPreview(previewLike, buildImportSnapshot())
  }

  function openManualDraftSaveEditor(defaultName = '', { activateAfterSave = false, useCurrentMapping = false } = {}) {
    const normalizedDefaultName = String(defaultName || '').trim()
    setManualDraftSaveName(normalizedDefaultName)
    setManualDraftSaveActivate(activateAfterSave)
    setManualDraftSaveUseCurrent(useCurrentMapping)
    setShowManualDraftSave(true)
  }

  function closeManualDraftSaveEditor() {
    setShowManualDraftSave(false)
    setManualDraftSaveName('')
  }

  async function maybePromptCompatibleUnknownImports(profileId) {
    if (!profileId) return
    try {
      const response = await api.getCompatibleImportBatches(profileId)
      const compatibleBatches = Array.isArray(response?.batches) ? response.batches : []
      if (compatibleBatches.length > 0) {
        setCompatibleBatchPrompt({
          profileId,
          profileName: response?.profile_name || profiles.find(profile => profile.id === profileId)?.name || 'Saved data source',
          batches: compatibleBatches,
        })
      }
    } catch {
      // Leave compatible imports untouched if the suggestion lookup fails.
    }
  }

  async function attachCompatibleUnknownImports() {
    const prompt = compatibleBatchPrompt
    if (!prompt?.profileId || !prompt?.batches?.length) {
      setCompatibleBatchPrompt(null)
      return
    }
    setAttachingCompatibleBatches(true)
    try {
      for (const batch of prompt.batches) {
        await api.setBatchProfile(batch.id, prompt.profileId)
      }
      setBatches(await api.listBatches())
      setCompatibleBatchPrompt(null)
    } catch (error) {
      setNoticeDialog({
        title: 'Could not attach compatible imports',
        description: error?.message || 'Please try again.',
      })
    } finally {
      setAttachingCompatibleBatches(false)
    }
  }

  // Move a profileless (unknown-source) imported file under an existing data source. Pure
  // re-grouping — it does not re-import or re-map; the batch keeps its own imported data.
  // The temporary-draft card always shows the most recent profileless, non-fallback batch; the
  // browser-local draft snapshot tracks that same batch. Used to know when assigning/saving that
  // batch away should also drop the now-orphaned local draft.
  function getTemporaryDraftBatch() {
    return batches
      .filter(batch => !batch.profile_id && !batch.unknown_source_fallback)
      .sort((a, b) => String(b.imported_at || '').localeCompare(String(a.imported_at || '')))[0] || null
  }

  function clearTemporaryDraftIfBatchIsCurrent(batchId) {
    if (getTemporaryDraftBatch()?.id !== batchId) return
    clearSavedImportDraft(dbInstanceId, preferenceSubjectId)
    setManualDraftRecord(null)
  }

  async function assignUnknownBatchToProfile(batchId, profileId) {
    if (!profileId) return
    const wasTemporaryDraft = getTemporaryDraftBatch()?.id === batchId
    try {
      await api.setBatchProfile(batchId, profileId)
      if (wasTemporaryDraft) clearTemporaryDraftIfBatchIsCurrent(batchId)
      setBatches(await api.listBatches())
    } catch (error) {
      setNoticeDialog({ title: 'Could not assign to data source', description: error?.message || 'Please try again.' })
    }
  }

  // "+ New data source from this file": create a saved data source from the batch's own import
  // mapping (server-side, where the snapshot lives) and link the file to it.
  async function createDataSourceFromUnknownBatch(batch, rawName) {
    const name = (rawName || '').trim()
    if (!name || !batch) return
    const wasTemporaryDraft = getTemporaryDraftBatch()?.id === batch.id
    try {
      await api.createProfileFromBatch(batch.id, name, inferFilenamePattern(batch.filename || '') || null)
      setAssignNewSourceBatchId('')
      setAssignNewSourceName('')
      if (wasTemporaryDraft) clearTemporaryDraftIfBatchIsCurrent(batch.id)
      const [nextProfiles, nextBatches] = await Promise.all([api.getImportProfiles(), api.listBatches()])
      setProfiles(nextProfiles)
      setBatches(nextBatches)
    } catch (error) {
      setNoticeDialog({ title: 'Could not create data source', description: error?.message || 'Please try again.' })
    }
  }

  function queueMappingBaselineCapture() {
    setPendingMappingBaselineCapture(true)
  }

  function applyInferredMappingSuggestions(inferredMapping) {
    const columnMap = inferredMapping?.columnMap || {}
    setMappingSuggestions({
      date: columnMap.date || '',
      amount: columnMap.amount || '',
      debit: columnMap.debit || '',
      credit: columnMap.credit || '',
      direction: columnMap.direction || '',
      description: columnMap.description || '',
      category: columnMap.category || '',
      notes: columnMap.notes || '',
      pending: columnMap.pending || '',
      currency: columnMap.currency || '',
      transaction_id: columnMap.transaction_id || '',
      account: columnMap.account || '',
    })
  }

  function buildProfileMappingSuggestions(previewLike, {
    skipRowsValue = 0,
    amountConvention = amtConv,
    currentValues = {},
  } = {}) {
    if (!previewLike?.headers?.length) return getBlankMappingSuggestions()
    const inferredMapping = inferUnambiguousImportMappingFromPreview(previewLike, skipRowsValue)
    const nextSuggestions = getBlankMappingSuggestions()

    const assignSuggestion = (field, currentValue) => {
      const inferredValue = inferredMapping?.columnMap?.[field] || ''
      if (!currentValue && inferredValue && previewLike.headers.includes(inferredValue)) {
        nextSuggestions[field] = inferredValue
      }
    }

    assignSuggestion('date', currentValues.date)
    assignSuggestion('description', currentValues.description)
    assignSuggestion('category', currentValues.category)
    assignSuggestion('notes', currentValues.notes)
    assignSuggestion('pending', currentValues.pending)
    assignSuggestion('currency', currentValues.currency)
    assignSuggestion('transaction_id', currentValues.transaction_id)
    assignSuggestion('account', currentValues.account)

    if (amountConvention === 'two_column') {
      assignSuggestion('debit', currentValues.debit)
      assignSuggestion('credit', currentValues.credit)
    } else if (amountConvention === 'single_unsigned') {
      assignSuggestion('amount', currentValues.amount)
      assignSuggestion('direction', currentValues.direction)
    } else {
      assignSuggestion('amount', currentValues.amount)
    }

    return nextSuggestions
  }

  function getCurrentManualSourceSnapshot(previewLike = preview) {
    const savedDraft = loadSavedImportDraft(previewLike, dbInstanceId, preferenceSubjectId)
    if (savedDraft) return savedDraft
    if (previewLike?.config_snapshot) {
      return {
        ...previewLike.config_snapshot,
        skip_accounts: [],
      }
    }
    return null
  }

  function hasMappingChanges() {
    if (!mappingBaselineSnapshot) return false
    return stableSerialize(buildImportSnapshot()) !== mappingBaselineSnapshot
  }

  function resetToManualImportMapping() {
    setSelectedProfile('')
    applySnapshot(getBlankImportSnapshot())
    setMappingSuggestions(getBlankMappingSuggestions())
    setDateFormatLocked(false)
    setDecimalSeparatorLocked(false)
  }

  function resetToSuggestedImportMapping(profileId = '', previewLike = preview) {
    const inferredMapping = inferUnambiguousImportMappingFromPreview(previewLike, 0)
    const inferredCharacteristics = inferImportFileCharacteristicsFromPreview(previewLike, 0)
    setSelectedProfile(profileId || '')
    setShowMappingSourceChooser(false)
    setAccountId('')
    setDateFormat(inferredCharacteristics.dateFormat || '%m/%d/%Y')
    setDateFormatLocked(false)
    setAmtConv(inferredCharacteristics.amountConvention || 'single_signed')
    setDecimalSeparator(inferredCharacteristics.decimalSeparator || DEFAULT_DECIMAL_SEPARATOR)
    setDecimalSeparatorLocked(false)
    setSkipRows(0)
    setApplyCat(true)
    setEnrichFromSource(false)
    setUseImportedCategories(getDefaultImportedCategoryUsageEnabled(defaultImportCategoryUsageMode))
    setImportedCategorySettings(getBlankImportedCategorySettings())
    setColDate(null)
    setColAmount(null)
    setColDebit(null)
    setColCredit(null)
    setColDir(null)
    setColDesc(null)
    setColCategory(null)
    setColNotes(null)
    setColPending(null)
    setColCurrency(null)
    setColTransactionId(null)
    setColAccount(null)
    setEvidenceColumns(null)
    applyInferredMappingSuggestions(inferredMapping)
    setAccountMap({})
    setCategoryAssignments({})
    setSingleAccountNew({ enabled: false, name: '', type: 'depository' })
  }

  function resetImportMappingState() {
    setSelectedProfile('')
    setShowMappingSourceChooser(false)
    setMappingBaselineSnapshot('')
    setPendingMappingBaselineCapture(false)
    setAccountId('')
    setDateFormat('%m/%d/%Y')
    setDateFormatLocked(false)
    setAmtConv('single_signed')
    setDecimalSeparator(DEFAULT_DECIMAL_SEPARATOR)
    setDecimalSeparatorLocked(false)
    setSkipRows(0)
    setApplyCat(true)
    setEnrichFromSource(false)
    setUseImportedCategories(getDefaultImportedCategoryUsageEnabled(defaultImportCategoryUsageMode))
    setImportedCategorySettings(getBlankImportedCategorySettings())
    setColDate(null)
    setColAmount(null)
    setColDebit(null)
    setColCredit(null)
    setColDir(null)
    setColDesc(null)
    setColCategory(null)
    setColNotes(null)
    setColPending(null)
    setColCurrency(null)
    setColTransactionId(null)
    setColAccount(null)
    setEvidenceColumns(null)
    setMappingSuggestions(getBlankMappingSuggestions())
    setAccountMap({})
    setCategoryAssignments({})
    setSingleAccountNew({ enabled: false, name: '', type: 'depository' })
    setImportFiles([])
    setImportFilePreviews([])
  }

  function performApplyProfile(profileId, previewLike = preview) {
    const p = profiles.find(x => x.id === profileId)
    if (!p) {
      if (!profileId) resetToManualImportMapping()
      else setSelectedProfile(profileId)
      return !profileId
    }
    setSelectedProfile(profileId)
    setMappingSuggestions(getBlankMappingSuggestions())
    const cm = p.column_map || {}
    // A column the file no longer carries cannot be mapped to anything. Restoring the stored name
    // would show a picker naming a column that is not there (the picker renders the raw value) and
    // read blank cells from it, so it is dropped and the field falls to the suggestion engine below;
    // the mapping screen's column-change notice is what says why it went empty. An empty header set
    // means there is nothing to check against, not that every mapping is stale.
    const fileHeaders = new Set(previewLike?.headers || [])
    const mapped = key => {
      const header = cm[key] || null
      if (!header) return null
      return fileHeaders.size === 0 || fileHeaders.has(header) ? header : null
    }
    const existingSingleAccount = cm.single_account_new?.name
      ? findExactAccountNameMatch(accounts, cm.single_account_new.name)
      : null
    const existingAssignedAccount = p.account_id
      ? accounts.find(a => a.id === p.account_id)
      : null
    setAccountId(existingSingleAccount ? existingSingleAccount.id : (existingAssignedAccount?.id || '')); setDateFormat(p.date_format || '%m/%d/%Y')
    setDateFormatLocked(true)
    setAmtConv(p.amount_convention || 'single_signed'); setSkipRows(p.skip_rows || 0)
    setDecimalSeparator(p.decimal_separator || DEFAULT_DECIMAL_SEPARATOR)
    setDecimalSeparatorLocked(true)
    setApplyCat(!!p.apply_categorization)
    setEnrichFromSource(!!p.enrich_from_source)
    setUseImportedCategories(!!p.use_imported_categories)
    setImportedCategorySettings(extractImportedCategorySettings(p))
    setColDate(mapped('date')); setColAmount(mapped('amount')); setColDebit(mapped('debit'))
    setColCredit(mapped('credit')); setColDir(mapped('direction'))
    setColDesc(mapped('description')); setColCategory(mapped('category')); setColNotes(mapped('notes')); setColPending(mapped('pending')); setColCurrency(mapped('currency')); setColTransactionId(mapped('transaction_id'))
    // The suggestions are built from what is actually mapped, not from what the source stored: a
    // field just dropped for a missing column has to read as unmapped here or it is offered nothing.
    setMappingSuggestions(buildProfileMappingSuggestions(previewLike, {
      skipRowsValue: p.skip_rows || 0,
      amountConvention: p.amount_convention || 'single_signed',
      currentValues: {
        date: mapped('date') || '',
        amount: mapped('amount') || '',
        debit: mapped('debit') || '',
        credit: mapped('credit') || '',
        direction: mapped('direction') || '',
        description: mapped('description') || '',
        category: mapped('category') || '',
        notes: mapped('notes') || '',
        pending: mapped('pending') || '',
        currency: mapped('currency') || '',
        transaction_id: mapped('transaction_id') || '',
        account: mapped('account') || '',
      },
    }))
    setCategoryAssignments(cm.category_assignments || {})
    setSingleAccountNew(cm.single_account_new && !existingSingleAccount
      ? { enabled: true, name: cm.single_account_new.name || '', type: cm.single_account_new.type || 'depository' }
      : { enabled: false, name: '', type: 'depository' })
    const newColAccount = mapped('account')
    setAccountMap({})
    setColAccount(newColAccount)
    // A saved list restores the user's picks; its absence keeps null so the default set is derived
    // (matching the backend, where a profile without evidence_columns falls back to keyword auto-detect).
    setEvidenceColumns(Array.isArray(cm.evidence_columns) ? cm.evidence_columns : null)

    // Validate each stored account ID against the live accounts list — the account
    // may have been deleted since the profile was last saved. Fall back to name-match,
    // then to createNew so the user is prompted rather than silently sending a dead ID.
    if (newColAccount && (cm.account_assignments || cm.account_skips || cm.account_new)) {
      const restored = {}
      for (const [csvVal, aid] of Object.entries(cm.account_assignments || {})) {
        const stillExists = accounts.find(a => a.id === aid)
        if (stillExists) {
          restored[csvVal] = { accountId: aid, createNew: false, newName: stillExists.name, newType: stillExists.type || 'depository', groupWithAccountId: '', skip: false }
        } else {
          const byName = findExactAccountNameMatch(accounts, csvVal)
          if (byName) {
            restored[csvVal] = { accountId: byName.id, createNew: false, newName: byName.name, newType: byName.type || 'depository', groupWithAccountId: '', skip: false }
          } else {
            restored[csvVal] = { accountId: '', createNew: false, newName: csvVal, newType: '', groupWithAccountId: '', skip: false }
          }
        }
      }
      for (const csvVal of (cm.account_skips || [])) {
        restored[csvVal] = { accountId: '', createNew: false, newName: csvVal, newType: '', groupWithAccountId: '', skip: true }
      }
      for (const [csvVal, info] of Object.entries(cm.account_new || {})) {
        const existing = findExactAccountNameMatch(accounts, info.name)
        if (existing) {
          restored[csvVal] = { accountId: existing.id, createNew: false, newName: info.name, newType: info.type, groupWithAccountId: '', skip: false }
        } else {
          restored[csvVal] = { accountId: '', createNew: true, newName: info.name || csvVal, newType: info?.type ?? '', groupWithAccountId: '', skip: false }
        }
      }
      setAccountMap(restored)
    }
    return true
  }

  function applyProfile(profileId, options = {}) {
    const { bypassMismatchWarning = false, previewLike = preview, mismatchContext = 'mappingSwitch' } = options
    const p = profiles.find(x => x.id === profileId)
    if (!p) return performApplyProfile(profileId, previewLike)

    if (!bypassMismatchWarning && profileHeaderClearlyMismatches(p, previewLike)) {
      setShowProfileMismatchChooser(false)
      setPendingProfileMismatch({
        profileId,
        profileName: p.name,
        previewLike,
        context: mismatchContext,
      })
      return 'pending'
    }

    return performApplyProfile(profileId, previewLike)
  }

  function applySnapshot(snap, previewLike = preview) {
    if (!snap) return
    const cm = snap.column_map || {}
    const existingSingleAccount = snap.single_account_new?.name
      ? findExactAccountNameMatch(accounts, snap.single_account_new.name)
      : null
    const existingAssignedAccount = snap.account_id
      ? accounts.find(a => a.id === snap.account_id)
      : null
    setDateFormat(snap.date_format || '%m/%d/%Y'); setDateFormatLocked(true); setAmtConv(snap.amount_convention || 'single_signed')
    setDecimalSeparator(snap.decimal_separator || DEFAULT_DECIMAL_SEPARATOR); setDecimalSeparatorLocked(true)
    setSkipRows(snap.skip_rows || 0); setApplyCat(snap.apply_categorization !== false)
    setEnrichFromSource(!!snap.enrich_from_source)
    setUseImportedCategories(!!snap.use_imported_categories)
    setImportedCategorySettings(extractImportedCategorySettings(snap))
    setColDate(cm.date || null); setColAmount(cm.amount || null); setColDebit(cm.debit || null)
    setColCredit(cm.credit || null); setColDir(cm.direction || null)
    setColDesc(cm.description || null); setColCategory(cm.category || null); setColNotes(cm.notes || null); setColPending(cm.pending || null); setColCurrency(cm.currency || null); setColTransactionId(cm.transaction_id || null); setColAccount(cm.account || null)
    setEvidenceColumns(Array.isArray(cm.evidence_columns) ? cm.evidence_columns : null)
    setMappingSuggestions(buildProfileMappingSuggestions(previewLike, {
      skipRowsValue: snap.skip_rows || 0,
      amountConvention: snap.amount_convention || 'single_signed',
      currentValues: {
        date: cm.date || '',
        amount: cm.amount || '',
        debit: cm.debit || '',
        credit: cm.credit || '',
        direction: cm.direction || '',
        description: cm.description || '',
        category: cm.category || '',
        notes: cm.notes || '',
        pending: cm.pending || '',
        currency: cm.currency || '',
        transaction_id: cm.transaction_id || '',
        account: cm.account || '',
      },
    }))
    setCategoryAssignments((snap.category_assignments || cm.category_assignments || {}))
    setAccountId(existingSingleAccount ? existingSingleAccount.id : (existingAssignedAccount?.id || ''))
    setSingleAccountNew(snap.single_account_new && !existingSingleAccount
      ? { enabled: true, name: snap.single_account_new.name || '', type: snap.single_account_new.type || 'depository' }
      : { enabled: false, name: '', type: 'depository' })
    if (snap.account_map || snap.skip_accounts || snap.account_new) {
      const restored = {}
      const skips = new Set(snap.skip_accounts || [])
      for (const [val, aid] of Object.entries(snap.account_map || {})) {
        const stillExists = accounts.find(a => a.id === aid)
        if (stillExists) {
          restored[val] = { accountId: aid, createNew: false, newName: stillExists.name, newType: stillExists.type || 'depository', groupWithAccountId: '', skip: false }
        } else {
          const byName = findExactAccountNameMatch(accounts, val)
          if (byName) {
            restored[val] = { accountId: byName.id, createNew: false, newName: byName.name, newType: byName.type || 'depository', groupWithAccountId: '', skip: false }
          } else {
            restored[val] = { accountId: '', createNew: false, newName: val, newType: '', groupWithAccountId: '', skip: false }
          }
        }
      }
      for (const val of skips) {
        restored[val] = { accountId: '', createNew: false, newName: val, newType: '', groupWithAccountId: '', skip: true }
      }
      for (const [val, info] of Object.entries(snap.account_new || {})) {
        const existing = findExactAccountNameMatch(accounts, info?.name)
        if (existing) {
          restored[val] = { accountId: existing.id, createNew: false, newName: existing.name, newType: existing.type || info?.type || 'depository', groupWithAccountId: '', skip: false }
        } else {
          restored[val] = { accountId: '', createNew: true, newName: info?.name || val, newType: info?.type ?? '', groupWithAccountId: '', skip: false }
        }
      }
      setAccountMap(restored)
    }
    return true
  }

  function switchMappingDataSource(nextSourceId) {
    if (!preview) return false
    const nextIsManual = !nextSourceId || nextSourceId === MANUAL_DATA_SOURCE_VALUE
    const currentIsManual = !selectedProfile
    const sourceChanged = nextIsManual ? !currentIsManual : selectedProfile !== nextSourceId
    if (!sourceChanged) {
      setShowMappingSourceChooser(false)
      return true
    }
    if (hasMappingChanges()) {
      setPendingMappingSourceSwitch({ nextSourceId })
      return false
    }

    if (nextIsManual) {
      selectUploadSource(MANUAL_DATA_SOURCE_VALUE, { persist: false })
      const manualSnapshot = getCurrentManualSourceSnapshot(preview)
      if (manualSnapshot) applySnapshot(manualSnapshot)
      else resetToManualImportMapping()
    } else {
      const applied = applyProfile(nextSourceId, { previewLike: preview, mismatchContext: 'mappingSwitch' })
      if (applied !== true) return false
      selectUploadSource(nextSourceId)
    }

    setShowMappingSourceChooser(false)
    queueMappingBaselineCapture()
    return true
  }

  function confirmMappingSourceSwitch() {
    const nextSourceId = pendingMappingSourceSwitch?.nextSourceId
    setPendingMappingSourceSwitch(null)
    if (nextSourceId === undefined || nextSourceId === null) return
    const nextIsManual = !nextSourceId || nextSourceId === MANUAL_DATA_SOURCE_VALUE

    if (nextIsManual) {
      selectUploadSource(MANUAL_DATA_SOURCE_VALUE, { persist: false })
      const manualSnapshot = getCurrentManualSourceSnapshot(preview)
      if (manualSnapshot) applySnapshot(manualSnapshot)
      else resetToManualImportMapping()
    } else {
      const applied = applyProfile(nextSourceId, { previewLike: preview, mismatchContext: 'mappingSwitch' })
      if (applied !== true) return
      selectUploadSource(nextSourceId)
    }

    setShowMappingSourceChooser(false)
    queueMappingBaselineCapture()
  }

  // Apply a resolved data source to the already-previewed file and advance to the mapping stage.
  // `effectiveSource` is a profile id, MANUAL_DATA_SOURCE_VALUE, or '' (treated as a temporary draft).
  // Returns false when it could not settle — a profile mismatch opened the verification picker, or the
  // profile vanished — so the caller leaves the user on the upload stage.
  function proceedWithImport(effectiveSource, result) {
    const savedDraft = loadSavedImportDraft(result, dbInstanceId, preferenceSubjectId)
    if (effectiveSource && effectiveSource !== MANUAL_DATA_SOURCE_VALUE) {
      selectUploadSource(effectiveSource)
      const applied = applyProfile(effectiveSource, { previewLike: result, mismatchContext: 'upload' })
      if (applied === 'pending') return false
      if (applied !== true) {
        setPreview(null)
        return false
      }
    } else {
      selectUploadSource(MANUAL_DATA_SOURCE_VALUE)
      if (savedDraft) {
        setSelectedProfile('')
        setMappingSuggestions(getBlankMappingSuggestions())
        applySnapshot(savedDraft, result)
      } else if (result.config_snapshot) {
        setMappingSuggestions(getBlankMappingSuggestions())
        applySnapshot({
          ...result.config_snapshot,
          skip_accounts: [],
        }, result)
      } else {
        const inferredMapping = inferUnambiguousImportMappingFromPreview(result, 0)
        const inferredCharacteristics = inferImportFileCharacteristicsFromPreview(result, 0)
        setDateFormat(inferredCharacteristics.dateFormat || '%m/%d/%Y')
        setAmtConv(inferredCharacteristics.amountConvention || 'single_signed')
        setDecimalSeparator(inferredCharacteristics.decimalSeparator || DEFAULT_DECIMAL_SEPARATOR)
        setDecimalSeparatorLocked(false)
        setColDate(null)
        setColAmount(null)
        setColDebit(null)
        setColCredit(null)
        setColDir(null)
        setColDesc(null)
        setColCategory(null)
        setColNotes(null)
        setColPending(null)
        setColCurrency(null)
        setColTransactionId(null)
        setColAccount(null)
        setEvidenceColumns(null)
        applyInferredMappingSuggestions(inferredMapping)
      }
    }
    // When the header is inferred below the first line, surface the skip-row
    // controls immediately but leave the raw file viewer as an explicit review step.
    if ((result.header_row_index ?? 0) > 0) {
      setShowAdvanced(true)
    }
    queueMappingBaselineCapture()
    setStage('mapping')
    return true
  }

  // The upload flow is drop-first: a dropped file is previewed, then its header is matched against the
  // saved data sources. One match applies straight away; several open a chooser; none falls back to a
  // temporary draft. An explicit source (the data-source picker / Change) bypasses detection but still
  // runs the mismatch verification inside proceedWithImport.
  async function handleFile(file, options = {}) {
    if (!file) return
    if (isPaypalStatementCandidate(file)) {
      setPaypalStatementFiles([file])
      return
    }
    // An AZAD Amazon export isn't a mappable CSV — detect it by header and hand it to the Amazon import
    // form (which owns the account choice + linking) instead of the column-mapping path.
    const head = await file.slice(0, 16384).text().catch(() => '')
    if (sniffAmazonExportKind(head.split(/\r?\n/, 1)[0])) {
      setAmazonFiles([file])
      // A file handed back from a watched folder names its source, whose settings the form starts from.
      setAmazonSourceId(options.sourceIdOverride || null)
      return
    }
    const explicitSource = options.sourceIdOverride ?? selectedUploadSource
    setLoading(true)
    try {
      resetImportMappingState()
      setShowRaw(false)
      setShowAdvanced(false)
      const result = await api.previewCsv(file)
      setPreview({ ...result, file }); setAccountMap({})
      setSingleAccountNew({ enabled: false, name: '', type: 'depository' })
      setCategoryAssignments({})

      let effectiveSource = explicitSource
      if (!effectiveSource) {
        const matches = findProfilesMatchingPreview(result, profiles)
        if (matches.length > 1) {
          // Ambiguous — hold the previewed file and let the user pick which source to apply.
          setPendingSourceMatchChoice({ previewLike: result, matches })
          return
        }
        effectiveSource = matches.length === 1 ? matches[0].id : MANUAL_DATA_SOURCE_VALUE
      }
      proceedWithImport(effectiveSource, result)
    } catch (e) {
      const msg = e?.message || e?.detail || 'Unable to parse CSV file.'
      setNoticeDialog({
        title: 'Failed to parse CSV',
        description: msg,
      })
    } finally { setLoading(false) }
  }

  // Multi-file entry point: a shortcut for importing several files one at a time. A single file goes
  // through the untouched single-file path; several files are previewed and grouped by data source
  // (header fingerprint). All one source -> straight to the mapping stage carrying the file group; more
  // than one source -> a chooser so the user picks which source to import.
  async function handleFiles(fileList) {
    const files = Array.from(fileList || [])
    if (!files.length) return
    if (initialDataStatus === 'loading') {
      setFilesAwaitingInitialData(files)
      return
    }
    if (initialDataStatus === 'failed') {
      setNoticeDialog({
        title: 'Could not load data sources',
        description: 'The saved data sources and accounts could not be loaded, so the file cannot be matched to a data source. Reload the page and try again.',
      })
      return
    }
    // PayPal statements (PDFs, or zips of them) go to their own import; the rest are CSV or Amazon.
    const statementFiles = files.filter(isPaypalStatementCandidate)
    if (statementFiles.length) setPaypalStatementFiles(statementFiles)
    const otherFiles = files.filter(file => !isPaypalStatementCandidate(file))
    // Route any AZAD Amazon exports to the Amazon import form (which accepts several); the rest are CSV.
    const amazon = []
    const csvFiles = []
    for (const file of otherFiles) {
      const head = await file.slice(0, 16384).text().catch(() => '')
      if (sniffAmazonExportKind(head.split(/\r?\n/, 1)[0])) amazon.push(file)
      else csvFiles.push(file)
    }
    if (amazon.length) { setAmazonFiles(amazon); setAmazonSourceId(null) }
    if (!csvFiles.length) return
    // One file: preserve the existing single-file behavior (saved drafts, source-match chooser) exactly.
    if (csvFiles.length === 1) { handleFile(csvFiles[0]); return }

    setLoading(true)
    try {
      const entries = []
      const unreadable = []
      for (const file of csvFiles) {
        try {
          const preview = await api.previewCsv(file)
          entries.push({ file, preview })
        } catch {
          unreadable.push(file.name)
        }
      }
      if (!entries.length) {
        setNoticeDialog({
          title: 'Failed to parse CSV',
          description: 'None of the selected files could be read as CSV.',
        })
        return
      }
      const groups = groupFilesBySource(entries, profiles)
      if (groups.length === 1) {
        startGroupImport(groups[0], { unreadable })
      } else {
        setMultiSourceChoice({ groups, unreadable })
      }
    } finally {
      setLoading(false)
    }
  }

  // Set up the mapping stage for one same-source group of files. A representative file's preview drives
  // the mapping UI; runImport then applies that mapping to every file in `importFiles`.
  function startGroupImport(group, { unreadable = [] } = {}) {
    if (!group.files.length) return
    // Drive the mapping screen from a file that hasn't already been imported, so a duplicate sitting
    // first in the selection doesn't put the screen into the "already imported" state and block the whole
    // import. The duplicates stay in the group and are skipped during the sequential import instead.
    // (`previous_batch` only flags cross-session duplicates; a copy of another selected file is caught at
    // import time.) If *every* file was already imported, there's nothing to map — say so and stop.
    const repIndex = group.files.findIndex(entry => !entry.preview?.previous_batch)
    if (repIndex === -1) {
      const names = group.files.map(entry => entry.file.name)
      setNoticeDialog({
        title: 'Already imported',
        description: names.length === 1
          ? `${names[0]} has already been imported.`
          : `All ${names.length} selected files have already been imported.`,
      })
      return
    }
    const representative = group.files[repIndex].preview
    const representativeFile = group.files[repIndex].file
    setMultiSourceChoice(null)
    resetImportMappingState()
    setShowRaw(false)
    setShowAdvanced(false)
    setPreview({ ...representative, file: representativeFile })
    setAccountMap({})
    setSingleAccountNew({ enabled: false, name: '', type: 'depository' })
    setCategoryAssignments({})
    setImportFiles(group.files.map(entry => entry.file))
    setImportFilePreviews(group.files.map(entry => entry.preview))
    if (unreadable.length) {
      setNoticeDialog({
        title: 'Some files were skipped',
        description: `Could not read: ${unreadable.join(', ')}. The remaining files will be imported.`,
      })
    }
    if (group.ambiguous) {
      // The shape matches several saved sources — reuse the single-file chooser to pick which one; the
      // file group is already staged in importFiles and survives the choice.
      setPendingSourceMatchChoice({ previewLike: representative, matches: group.matchedProfiles })
      return
    }
    proceedWithImport(group.profileId || MANUAL_DATA_SOURCE_VALUE, representative)
  }

  function handleSourceMatchChoice(sourceId) {
    const pending = pendingSourceMatchChoice
    setPendingSourceMatchChoice(null)
    if (!pending) return
    proceedWithImport(sourceId || MANUAL_DATA_SOURCE_VALUE, pending.previewLike)
  }

  function cancelSourceMatchChoice() {
    setPendingSourceMatchChoice(null)
    setPreview(null)
    setImportFiles([])
    setImportFilePreviews([])
  }

  function handleProfileMismatchConfirm() {
    if (!pendingProfileMismatch?.profileId) return
    const { profileId, previewLike, context } = pendingProfileMismatch
    setPendingProfileMismatch(null)
    setShowProfileMismatchChooser(false)
    // Continuing applies the source, mapping and all — a header that gained a column is the same data
    // source, and re-inferring from the file threw away exactly the account assignments and column
    // picks the source exists to hold. "This is the wrong source" has its own way out: Change data
    // source -> Skip takes a temporary draft with an inferred mapping.
    applyProfile(profileId, { bypassMismatchWarning: true, previewLike, mismatchContext: context })

    if (context === 'upload') {
      setStage('mapping')
      queueMappingBaselineCapture()
    } else if (context === 'mappingSwitch') {
      selectUploadSource(profileId)
      setShowMappingSourceChooser(false)
      queueMappingBaselineCapture()
    }
  }

  function handleProfileMismatchCancel() {
    const context = pendingProfileMismatch?.context
    setPendingProfileMismatch(null)
    setShowProfileMismatchChooser(false)
    if (context === 'upload') {
      setPreview(null)
    }
  }

  function handleProfileMismatchChangeDataSource() {
    setShowProfileMismatchChooser(true)
  }

  function handleProfileMismatchChooserBack() {
    setShowProfileMismatchChooser(false)
  }

  function handleProfileMismatchSelectSource(nextSourceId) {
    const pending = pendingProfileMismatch
    if (!pending) return
    const { previewLike, context } = pending

    if (!nextSourceId || nextSourceId === MANUAL_DATA_SOURCE_VALUE) {
      setPendingProfileMismatch(null)
      setShowProfileMismatchChooser(false)
      selectUploadSource(MANUAL_DATA_SOURCE_VALUE, { persist: false })
      resetToSuggestedImportMapping('', previewLike)
      if (context === 'upload') {
        setStage('mapping')
      } else {
        setShowMappingSourceChooser(false)
      }
      queueMappingBaselineCapture()
      return
    }

    const applied = applyProfile(nextSourceId, { previewLike, mismatchContext: context })
    if (applied !== true) return

    setPendingProfileMismatch(null)
    setShowProfileMismatchChooser(false)
    selectUploadSource(nextSourceId)

    if (context === 'upload') {
      setStage('mapping')
    } else {
      setShowMappingSourceChooser(false)
    }
    queueMappingBaselineCapture()
  }

  useEffect(() => {
    if (!pendingMappingBaselineCapture || stage !== 'mapping' || !preview) return
    setMappingBaselineSnapshot(stableSerialize(buildImportSnapshot()))
    setPendingMappingBaselineCapture(false)
  }, [pendingMappingBaselineCapture, stage, preview, buildImportSnapshot])

  useEffect(() => {
    if (initialDataStatus === 'loading' || !filesAwaitingInitialData) return
    setFilesAwaitingInitialData(null)
    handleFiles(filesAwaitingInitialData)
    // handleFiles is a plain function redeclared every render. The instance called here belongs to the
    // render that committed the settled load, which is the whole point, so listing it would only re-run
    // this effect for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDataStatus, filesAwaitingInitialData])

  function handleDrop(e) {
    e.preventDefault()
    // While the explicit data-source picker is open the user must choose a source first.
    if (sourceChooserOpen) return
    handleFiles(e.dataTransfer.files)
  }

  function getColumnMap() {
    return {
      date: colDate, amount: colAmount, debit: colDebit, credit: colCredit,
      direction: colDir, description: colDesc, category: colCategory, notes: colNotes, pending: colPending, currency: colCurrency, transaction_id: colTransactionId, account: colAccount,
      // Authoritative capture set (see backend _build_evidence_column_plan): exactly these columns are
      // kept as import evidence. Resolved from the user's picks or the derived default.
      evidence_columns: resolvedEvidenceColumns,
    }
  }

  function getMappingDisabledReason() {
    const missingRequiredColumns = []
    if (!colDate) missingRequiredColumns.push('date')
    if (!colDesc) missingRequiredColumns.push('merchant')
    if (amtConv === 'two_column') {
      if (!colDebit) missingRequiredColumns.push('debit')
      if (!colCredit) missingRequiredColumns.push('credit')
    } else if (!colAmount) {
      missingRequiredColumns.push('amount')
    }

    const issues = []
    if (missingRequiredColumns.length === 1) {
      issues.push(`Map the ${missingRequiredColumns[0]} column.`)
    } else if (missingRequiredColumns.length > 1) {
      issues.push('Map required columns.')
    }

    if (colAccount) {
      let unresolvedCount = 0
      let singleMessage = ''
      for (const value of remainingAccountValues) {
        const problem = accountMappingProblem(accountMap[value], accounts)
        if (!problem) continue
        unresolvedCount += 1
        singleMessage = {
          unmapped: `Choose an account for "${value}".`,
          new_name: `Enter a new account name for "${value}".`,
          new_type: `Choose an account type for "${value}".`,
          new_name_taken: `Select the existing account "${accountMap[value]?.newName?.trim()}" instead of creating a duplicate.`,
        }[problem]
      }
      if (unresolvedCount === 1) issues.push(singleMessage)
      else if (unresolvedCount > 1) issues.push('Resolve unmapped accounts.')
    }

    if (preview?.previous_batch && !colAccount) {
      issues.push('This file has already been imported. Undo the earlier import first.')
    }
    if (preview?.previous_batch && colAccount && remainingAccountValues.length === 0) {
      issues.push('All accounts in this file were already imported.')
    }

    if (singleAccountNew.enabled) {
      const name = singleAccountNew.name.trim()
      if (!name) issues.push('Enter a name for the new account.')
      if (accounts.some(a => a.name.toLowerCase() === name.toLowerCase())) {
        issues.push(`Select the existing account "${name}" instead of creating a duplicate.`)
      }
    }

    if (!colAccount && !singleAccountNew.enabled && !accountId) {
      issues.push('Choose the account to import into.')
    }

    return issues.join(' ')
  }

  function canCreateDataSourceFromCurrentMapping() {
    return !!preview && !selectedProfile && !getMappingDisabledReason()
  }

  function getCreateDataSourceDisabledReason() {
    return getMappingDisabledReason()
  }

  function canImport() {
    if (getMappingDisabledReason()) return false

    if (importableRowCount <= 0 && !(preview?.previous_batch && colAccount && remainingAccountValues.length === 0) && !(preview?.previous_batch && !colAccount)) {
      return false
    }

    if (preview?.previous_batch && !colAccount) return false
    if (preview?.previous_batch && colAccount && remainingAccountValues.length === 0) return false
    return true
  }

  function getImportDisabledReason() {
    const issues = []
    const mappingReason = getMappingDisabledReason()
    if (mappingReason) issues.push(mappingReason)

    if (preview?.previous_batch && !colAccount) {
      issues.push('This file has already been imported. Undo the earlier import first.')
    }
    if (preview?.previous_batch && colAccount && remainingAccountValues.length === 0) {
      issues.push('All accounts in this file were already imported.')
    }

    if (importableRowCount <= 0 && !(preview?.previous_batch && colAccount && remainingAccountValues.length === 0) && !(preview?.previous_batch && !colAccount)) {
      issues.push('No rows remain to import.')
    }

    return issues.join(' ')
  }

  async function runImport() {
    if (!canImport()) return
    setLoading(true)
    try {
      // The account mapping for one file: only the CSV account values that actually appear in *that*
      // file (its own preview's distinct values). For a same-source multi-select this means each new
      // account is created by the first file that contains it — the backend then reuses it by name for
      // later files (find-or-create) — and a file is never asked to create an account it has no rows for.
      // `accountMap` may carry stale entries from other files/imports, so the per-file value set filters it.
      const buildAccountConfig = (filePreview) => {
        if (colAccount) {
          const relevantValues = new Set(filePreview?.column_distinct_values?.[colAccount] || [])
          const account_map = {}
          const new_accounts = []
          const skip_accounts = []
          for (const [v, m] of Object.entries(accountMap)) {
            if (!relevantValues.has(v)) continue
            if (m.skip) skip_accounts.push(v)
            else if (m.createNew) {
              new_accounts.push({
                csv_value: v,
                name: m.newName,
                type: m.newType,
                ...(m.groupWithAccountId ? { group_with_account_id: m.groupWithAccountId } : {}),
                // What the user ruled out by giving this value its own account: the possible matches the
                // mapping row showed, or the single account the chooser asked about. Recorded server-side
                // as one distinct-account assertion each, once the account exists.
                ...(m.distinctFromAccountIds?.length
                  ? { distinct_from_account_ids: m.distinctFromAccountIds }
                  : {}),
              })
            }
            else if (m.accountId) account_map[v] = m.accountId
          }
          return { account_map, skip_accounts, new_accounts: new_accounts.length ? new_accounts : null }
        }
        if (singleAccountNew.enabled) {
          return {
            account_map: null,
            skip_accounts: null,
            new_accounts: [{ csv_value: '__single_account__', name: singleAccountNew.name.trim(), type: singleAccountNew.type || 'depository' }],
          }
        }
        return { account_map: null, skip_accounts: null, new_accounts: null }
      }
      // Snapshot before the import so we can tell post-import whether a prior
      // profileless batch will be displaced into the unknown-source row.
      const hadPriorManualBatch = !selectedProfile && batches.some(b => !b.profile_id && !b.unknown_source_fallback)
      const columnMap = getColumnMap()
      const normalizedImportedCategorySettings = normalizeImportedCategorySettings(importedCategorySettings)
      // The mapping (columns, date/amount conventions, category settings) is identical for every file in
      // a same-source group; only the file, its filename, and its per-file account config vary.
      const baseConfig = {
        profile_id: selectedProfile || null,
        account_id: colAccount || singleAccountNew.enabled ? null : accountId,
        single_account_new: (!colAccount && singleAccountNew.enabled)
          ? { name: singleAccountNew.name.trim(), type: singleAccountNew.type || 'depository' }
          : null,
        date_format: dateFormat,
        amount_convention: amtConv,
        decimal_separator: decimalSeparator,
        column_map: columnMap,
        skip_rows: skipRows,
        apply_categorization: applyCat,
        enrich_from_source: enrichFromSource,
        use_imported_categories: useImportedCategories && !!colCategory,
        imported_category_scope_mode: normalizedImportedCategorySettings.scope_mode,
        imported_category_owner_ids: normalizedImportedCategorySettings.owner_ids,
        imported_category_unassigned_account_tokens: normalizedImportedCategorySettings.unassigned_account_tokens,
      }
      // Each file paired with its own preview (for the per-file account config). Single-file falls back
      // to the previewed file, unchanged.
      const importEntries = importFiles.length
        ? importFiles.map((file, i) => ({ file, filePreview: importFilePreviews[i], filename: file.name }))
        : [{ file: preview.file, filePreview: preview, filename: preview.filename }]
      let result
      if (importEntries.length === 1) {
        const only = importEntries[0]
        result = await runImportWithProgress(
          only.file,
          { ...baseConfig, ...buildAccountConfig(only.filePreview), filename: only.filename },
          setImportRowProgress,
        )
        setMultiImportProgress(null)
      } else {
        // Import each file as its own batch/card (the natural per-file result), one after another. A file
        // whose content was already imported (e.g. a duplicate copy in the selection) is skipped and the
        // rest continue — only a genuine error aborts the run.
        const perFile = []
        const skipped = []
        for (let i = 0; i < importEntries.length; i++) {
          const { file, filePreview, filename } = importEntries[i]
          setMultiImportProgress({ current: i + 1, total: importEntries.length, filename })
          setImportRowProgress(null)
          try {
            const fileResult = await runImportWithProgress(
              file,
              { ...baseConfig, ...buildAccountConfig(filePreview), filename },
              setImportRowProgress,
            )
            perFile.push({ filename, result: fileResult })
          } catch (err) {
            if (err?.status === 409 && err?.detail?.reason === 'already_imported') {
              skipped.push({ filename, matchedFilename: err.detail.already_imported_filename || '' })
              continue
            }
            throw err
          }
        }
        setMultiImportProgress(null)
        result = buildMultiFileResult(perFile)
        result.skipped = skipped
      }
      setImportResult(result)
      if (result.trailing_non_transaction_suspected || result.invalid_rows_suspected) setShowRaw(true)
      const refreshedAccounts = await api.getAccounts({ include_children: true })
      setAccounts(refreshedAccounts)
      // Force the target row open so the completed file card is visible immediately,
      // even if this source was collapsed in the user's saved history view.
      // For temporary draft imports, also expand unknown-source if a prior batch
      // is being displaced into it by the new import becoming the active draft.
      // The batch's actual data source (from the backend result) wins — it includes an auto-created source
      // like the PayPal one, which the frontend's `selectedProfile` doesn't know about. A multi-file import
      // shares one profile across its per-file results.
      const resolvedProfileId = result.multiFile
        ? (result.perFile || []).map(entry => entry?.result?.profile_id).find(Boolean)
        : result.profile_id
      const rowKeyToExpand = resolvedProfileId
        ? `profile:${resolvedProfileId}`
        : (selectedProfile ? `profile:${selectedProfile}` : 'manual-draft')
      setExpandedSourceRows(prev => {
        const next = { ...(prev && typeof prev === 'object' ? prev : {}), [rowKeyToExpand]: true }
        if (hadPriorManualBatch) next['unknown-source'] = true
        return next
      })
      api.listBatches().then(setBatches)
      // Refresh profiles too, so a data source the import just auto-created (the PayPal source) is known
      // and its header renders immediately instead of only after navigating away and back.
      api.getImportProfiles().then(setProfiles).catch(() => { })
      if (selectedProfile) {
        await autoSaveProfile(refreshedAccounts).catch(() => { })
      }
      if (result.multiFile) {
        // Each file landed as its own card, and the landing marks all of them; the per-file counts
        // are on the cards.
        maybeOpenMoneyMovementReview(result)
        const skipped = result.skipped || []
        const skipLines = skipped.map(formatSkippedImportMessage)
        if (result.fileCount > 0) {
          landOnImport(result, (result.perFile || []).map(entry => entry?.result?.batch_id).filter(Boolean), skipLines)
        } else {
          // Every file was already imported, so there is no new card to land on.
          setNoticeDialog({
            title: 'Nothing new to import',
            description: skipLines.map((line, i) => <div key={i} style={{ marginTop: i ? 6 : 0 }}>{line}</div>),
          })
          resetImport()
        }
      } else if (result.trailing_non_transaction_suspected) {
        setStage('review-data')
        maybeOpenMoneyMovementReview(result)
      } else if (result.invalid_rows_suspected) {
        // Held on the raw-file viewer opened above, which needs the staged file; closing it lands.
        setStage('review-rows')
        maybeOpenMoneyMovementReview(result)
      } else {
        landOnImport(result, [result.batch_id])
        maybeOpenMoneyMovementReview(result)
      }
    } catch (e) {
      setMultiImportProgress(null)
      setNoticeDialog({
        title: 'Import failed',
        description: e.message,
      })
    }
    finally {
      setImportRowProgress(null)
      setLoading(false)
    }
  }

  // After a PayPal import, offer the money-movement review. All PayPal imports share the one system
  // PayPal data source, so the review is scoped to that *profile* — it covers every PayPal type across
  // every import at once (single- or multi-file). Returns whether a review opened; non-fatal on failure.
  async function maybeOpenMoneyMovementReview(result) {
    const profileId = result?.multiFile
      ? (result.perFile || []).map(entry => entry?.result).find(r => r?.is_paypal && r?.profile_id)?.profile_id
      : (result?.is_paypal ? result?.profile_id : null)
    if (!profileId) return false
    try {
      const data = await api.getMoneyMovementTypes(profileId)
      if (data?.proposals?.some(proposal => proposal.money_movement)) {
        setMoneyMovementReview({ profileId, proposals: data.proposals, accountIds: data.account_ids || [] })
        return true
      }
    } catch { /* review is optional — ignore */ }
    return false
  }

  async function applyMoneyMovementRules({ add = [], remove = [] }) {
    if (!moneyMovementReview || (!add.length && !remove.length)) return
    setMoneyMovementApplying(true)
    try {
      const res = await api.applyMoneyMovementRules(moneyMovementReview.profileId, { add, remove })
      setMoneyMovementReview(null)
      api.getAccounts({ include_children: true }).then(setAccounts).catch(() => { })
      const changes = []
      if (res.created) changes.push(`added ${res.created} rule${res.created === 1 ? '' : 's'}`)
      if (res.deleted) changes.push(`removed ${res.deleted} rule${res.deleted === 1 ? '' : 's'}`)
      setNoticeDialog({
        title: 'Money movement updated',
        description: `${changes.join(', ') || 'No changes'} — ${res.recategorized} transaction${res.recategorized === 1 ? '' : 's'} recategorized.`,
      })
    } catch (e) {
      setNoticeDialog({ title: 'Could not update rules', description: e.message })
    } finally {
      setMoneyMovementApplying(false)
    }
  }

  // Open the review for a PayPal data source (from its header row) — the one place to add/remove
  // money-movement types across all of that source's imports.
  async function reviewMoneyMovementForProfile(profileId) {
    if (!profileId) return
    try {
      const data = await api.getMoneyMovementTypes(profileId)
      if (data?.proposals?.length) {
        setMoneyMovementReview({ profileId, proposals: data.proposals, editing: true, accountIds: data.account_ids || [] })
      } else {
        setNoticeDialog({ title: 'No transaction types', description: 'This data source captured no PayPal transaction types to review.' })
      }
    } catch (e) {
      setNoticeDialog({ title: 'Could not load types', description: e.message })
    }
  }

  async function createUploadDataSource() {
    const nextName = uploadSourceDraftName.trim()
    if (!nextName || creatingUploadSource) return
    setCreatingUploadSource(true)
    try {
      const response = await api.createImportProfile(buildEmptyDataSourceBody(nextName))
      const updatedProfiles = await api.getImportProfiles()
      setProfiles(updatedProfiles)
      selectUploadSource(response?.id || '')
      setShowUploadSourceCreate(false)
      setUploadSourceDraftName('')
    } catch (err) {
      setNoticeDialog({
        title: 'Could not create the data source',
        description: err?.message || 'Please try again.',
      })
    } finally {
      setCreatingUploadSource(false)
    }
  }

  async function handleManagerProfileCreated({ profileId, sampleFile } = {}) {
    if (!profileId) return
    selectUploadSource(profileId)
    if (sampleFile && stage === 'upload' && !preview) {
      await handleFile(sampleFile, { sourceIdOverride: profileId })
    }
  }

  async function saveManualDraftAsDataSource(options = {}) {
    const {
      draftRecord = manualDraftRecord,
      activateAfterSave = false,
    } = options
    const nextName = manualDraftSaveName.trim()
    const body = buildProfileBodyFromSnapshot(nextName, draftRecord)
    if (!body || !nextName || savingManualDraftSource) return
    setSavingManualDraftSource(true)
    try {
      const response = await api.createImportProfile(body)
      const newProfileId = response?.id
      // Only adopt the most-recent profileless batch into the new source when its file shape
      // actually matches. Saving a *fresh* mapping as a source (before that file is imported)
      // leaves the current file with no batch yet, so getTemporaryDraftBatch() would otherwise
      // return an unrelated earlier import and wrongly file it under this source.
      const newProfileFingerprint = String(body.header_fingerprint || '').trim()
      const currentTemporaryDraftBatch = getTemporaryDraftBatch()
      const batchFingerprint = String(currentTemporaryDraftBatch?.header_fingerprint || '').trim()
      if (newProfileId && currentTemporaryDraftBatch && newProfileFingerprint && batchFingerprint === newProfileFingerprint) {
        await api.setBatchProfile(currentTemporaryDraftBatch.id, newProfileId).catch(() => { })
      }
      const updatedProfiles = await api.getImportProfiles()
      setProfiles(updatedProfiles)
      clearSavedImportDraft(dbInstanceId, preferenceSubjectId)
      setManualDraftRecord(loadSavedImportDraftRecord(dbInstanceId, preferenceSubjectId))
      setShowManualDraftSave(false)
      setManualDraftSaveName('')
      if (newProfileId) {
        // Adopt the new source as the active selection only while actively mapping the matching file
        // (the "save current mapping as a data source" path). Saving from a completed import or the
        // data-sources list must not preselect a source — the upload flow is drop-first and detects
        // the source per file, so a leftover selection would wrongly default the next import.
        const shouldAdoptCurrentPreview = stage === 'mapping' && !selectedProfile && doesDraftMatchPreview(draftRecord, preview)
        if (activateAfterSave || shouldAdoptCurrentPreview) {
          selectUploadSource(newProfileId)
        }
        if (shouldAdoptCurrentPreview) {
          setSelectedProfile(newProfileId)
        }
        setExpandedSourceRows(prev => ({
          ...(prev && typeof prev === 'object' ? prev : {}),
          [`profile:${newProfileId}`]: true,
        }))
        if (activateAfterSave || shouldAdoptCurrentPreview) {
          queueMappingBaselineCapture()
        }
      }
      setBatches(await api.listBatches())
      if (newProfileId) {
        await maybePromptCompatibleUnknownImports(newProfileId)
      }
    } catch (error) {
      setNoticeDialog({
        title: 'Could not save the temporary draft as a data source',
        description: error?.message || 'Please try again.',
      })
    } finally {
      setSavingManualDraftSource(false)
    }
  }

  async function saveSourceName(profileId) {
    const profile = profiles.find(item => item.id === profileId)
    const nextValue = sourceNameDraft.trim()
    setEditingSourceNameKey('')
    setSourceNameDraft('')
    if (!profile || !nextValue || nextValue === profile.name) return
    setProfiles(prev => prev.map(item => (
      item.id === profileId
        ? { ...item, name: nextValue }
        : item
    )))
    try {
      await api.updateImportProfile(profileId, { name: nextValue })
    } catch (error) {
      api.getImportProfiles().then(setProfiles)
      setNoticeDialog({
        title: 'Could not rename the data source',
        description: error?.message || 'Please try again.',
      })
    }
  }

  // Silently update the active profile after a successful import so account
  // mappings (including new accounts and skips) are never lost
  async function autoSaveProfile(refreshedAccounts) {
    if (!selectedProfile) return
    const p = profiles.find(x => x.id === selectedProfile)
    if (!p) return
    // Newly created accounts do not have ids in the pre-import draft, so reconcile
    // them by name before saving the refreshed profile mappings.
    const resolvedMap = {}
    for (const [csvVal, m] of Object.entries(accountMap)) {
      if (m.createNew && m.newName?.trim()) {
        const created = refreshedAccounts.find(a => a.name === m.newName.trim())
        resolvedMap[csvVal] = created
          ? { ...m, createNew: false, accountId: created.id }
          : m
      } else {
        resolvedMap[csvVal] = m
      }
    }
    const existingProfileMap = { ...(p.column_map || {}) }
    const cm = keepMappingsForAbsentColumns(
      { ...existingProfileMap, ...getColumnMap() }, existingProfileMap, preview?.headers,
    )
    if (!colAccount && singleAccountNew.enabled && singleAccountNew.name.trim()) {
      cm.single_account_new = {
        name: singleAccountNew.name.trim(),
        type: singleAccountNew.type || 'depository',
      }
    } else {
      delete cm.single_account_new
    }
    const assignments = {}, skips = [], newAccts = {}
    for (const [csvVal, m] of Object.entries(resolvedMap)) {
      if (m.skip) {
        skips.push(csvVal)
      } else if (m.createNew && m.newName?.trim()) {
        newAccts[csvVal] = { name: m.newName.trim(), type: m.newType || '' }
      } else if (m.accountId) {
        assignments[csvVal] = m.accountId
      }
    }
    const currentFileValues = new Set(distinctAccountValues)
    const mergedAssignments = { ...(existingProfileMap.account_assignments || {}) }
    const mergedNewAccounts = { ...(existingProfileMap.account_new || {}) }
    const mergedSkipSet = new Set(existingProfileMap.account_skips || [])

    for (const csvVal of currentFileValues) {
      delete mergedAssignments[csvVal]
      delete mergedNewAccounts[csvVal]
      mergedSkipSet.delete(csvVal)
    }
    for (const [csvVal, accountId] of Object.entries(assignments)) {
      mergedAssignments[csvVal] = accountId
    }
    for (const [csvVal, info] of Object.entries(newAccts)) {
      mergedNewAccounts[csvVal] = info
    }
    for (const csvVal of skips) {
      mergedSkipSet.add(csvVal)
    }

    if (Object.keys(mergedAssignments).length > 0) cm.account_assignments = mergedAssignments
    else delete cm.account_assignments
    if (mergedSkipSet.size > 0) cm.account_skips = Array.from(mergedSkipSet).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    else delete cm.account_skips
    if (Object.keys(mergedNewAccounts).length > 0) cm.account_new = mergedNewAccounts
    else delete cm.account_new

    const body = {
      name: p.name,
      filename_pattern: inferFilenamePattern(preview.filename) || null,
      header_fingerprint: preview.header_fingerprint || null,
      template_filename: preview.filename || null,
      template_file_hash: preview.file_content_hash || null,
      column_map: cm,
      account_id: (!colAccount && !singleAccountNew.enabled && accountId) ? accountId : null,
      date_format: dateFormat,
      amount_convention: amtConv,
      decimal_separator: decimalSeparator,
      skip_rows: skipRows,
      apply_categorization: applyCat,
      enrich_from_source: enrichFromSource,
      use_imported_categories: useImportedCategories && !!colCategory,
      imported_category_scope_mode: normalizeImportedCategorySettings(importedCategorySettings).scope_mode,
      imported_category_owner_ids: normalizeImportedCategorySettings(importedCategorySettings).owner_ids,
      imported_category_unassigned_account_tokens: normalizeImportedCategorySettings(importedCategorySettings).unassigned_account_tokens,
    }
    await api.updateImportProfile(selectedProfile, body)
    clearSavedImportDraft(dbInstanceId, preferenceSubjectId)
    setManualDraftRecord(loadSavedImportDraftRecord(dbInstanceId, preferenceSubjectId))
    // Await the profiles refresh so state is up to date before the user
    // can cancel and re-upload — prevents stale profile being applied
    const updated = await api.getImportProfiles()
    setProfiles(updated)
  }

  // A finished import is shown where its record lives: its card in the history under the drop zone,
  // which the landing scrolls to and marks. The importer goes straight back to the drop zone, so the
  // next file can be dropped without dismissing anything. What a card cannot say — that this is the
  // import just run, the first-run prompts, files skipped from a multi-file selection — rides above
  // the list as a notice for as long as the landing is on screen.
  function landOnImport(result, batchIds, skipLines = []) {
    setStarterPromptDismissed(false)
    setLandedImport({
      result,
      batchIds,
      skipLines,
      usedImportedCategories: !!(useImportedCategories && colCategory),
    })
    resetImport()
    onShowHistory({ batchIds })
  }
  useEffect(() => {
    if (view !== 'import') setLandedImport(null)
  }, [view])
  // The drop zone is at the top of the tab the landing scrolled down.
  const tabTopRef = useRef(null)
  function importAnotherFile() {
    setLandedImport(null)
    onShowImport()
    tabTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // An Amazon import lands the same way, on the cards its files became. It does not reset the importer:
  // a CSV dropped alongside the Amazon files may be part-way through its mapping underneath.
  async function landOnAmazonImport(summary) {
    setAmazonFiles(null)
    const [nextBatches, nextAccounts] = await Promise.all([
      api.listBatches(), api.getAccounts({ include_children: true }),
    ])
    setBatches(nextBatches)
    setAccounts(nextAccounts)
    const batchIds = (summary.batches || []).map(b => b.batch_id).filter(Boolean)
    const skipLines = (summary.already_imported_files || []).map(filename => formatSkippedImportMessage({ filename }))
    const unattached = Number(summary.counts?.items_discarded || 0)
    if (unattached) {
      skipLines.push(
        `${unattached} order${unattached === 1 ? '' : 's'} of item detail had no matching order. The detail is `
        + 'saved, and importing the matching orders file attaches it.',
      )
    }
    if (!batchIds.length) {
      setNoticeDialog({
        title: 'Nothing new to import',
        description: skipLines.map((line, i) => <div key={i} style={{ marginTop: i ? 6 : 0 }}>{line}</div>),
      })
      return
    }
    const orders = Number(summary.order_count || 0)
    setLandedImport({
      batchIds,
      skipLines,
      headline: `${orders} order${orders === 1 ? '' : 's'} imported${batchIds.length > 1 ? ` across ${batchIds.length} files` : ''}.`,
    })
    onShowHistory({ batchIds })
  }

  function resetImport() {
    setStage('upload'); setPreview(null); setImportResult(null)
    setAccountMap({})
    setColPending(null)
    setColCurrency(null)
    setColTransactionId(null)
    setSingleAccountNew({ enabled: false, name: '', type: 'depository' })
    setCategoryAssignments({})
    setImportedCategorySettings(getBlankImportedCategorySettings())
    setShowRaw(false); setShowAdvanced(false)
    // Return to the drop-first auto-detect screen — no source carried over from the file just handled,
    // so the next import detects its own source rather than defaulting to the previous one.
    setSelectedUploadSource('')
    setSourceChooserOpen(false)
    setPendingSourceMatchChoice(null)
    resetImportMappingState()
  }

  // "Start over" returns to the upload screen with the explicit data-source picker open (rather than
  // the default auto-detect drop zone), since the user deliberately chose to reselect a source.
  function returnToUploadSourceChooser() {
    resetImport()
    setSourceChooserOpen(true)
    setShowUploadSourceCreate(false)
    setUploadSourceDraftName('')
  }

  // The tab's post-undo cleanup (the shared undo hook does the delete itself): clear the import-result
  // card, drop the stale manual draft / per-profile rule-learning state, then refetch batches.
  const handleBatchUndone = useCallback(async (batch) => {
    if (importResult?.batch_id === batch.id) {
      setImportResult(null)
      setStage('upload')
    }
    setLandedImport(prev => {
      if (!prev?.batchIds.includes(batch.id)) return prev
      const batchIds = prev.batchIds.filter(id => id !== batch.id)
      return batchIds.length ? { ...prev, batchIds } : null
    })
    const remainingBatches = batches.filter(b => b.id !== batch.id)
    if (!batch.profile_id) {
      const remainingManual = remainingBatches.filter(b => !b.profile_id)
      if (remainingManual.length === 0) {
        clearSavedImportDraft(dbInstanceId, preferenceSubjectId)
        setManualDraftRecord(null)
      }
    } else {
      const remainingForProfile = remainingBatches.filter(b => b.profile_id === batch.profile_id)
      if (remainingForProfile.length === 0) {
        const profile = profiles.find(p => p.id === batch.profile_id)
        if (profile) {
          const nextColumnMap = { ...(profile.column_map || {}) }
          delete nextColumnMap.rule_suggestion_review
          api.updateImportProfile(batch.profile_id, { column_map: nextColumnMap })
            .then(() => api.getImportProfiles().then(setProfiles))
            .catch(() => { })
        }
      }
    }
    await api.listBatches().then(setBatches)
  }, [importResult, batches, profiles, dbInstanceId, preferenceSubjectId])

  const { openUndo, undoNode } = useBatchUndo(handleBatchUndone)

  // Direct (no-confirm) undo used by the auto-undo path below; the confirm-dialog path goes through
  // the shared hook (openUndo).
  async function performBatchUndo(batch, force = false) {
    if (!batch?.id) return
    await api.undoBatch(batch.id, force)
    await handleBatchUndone(batch)
  }

  function openRuleSuggestionReview({ batchId = '', profileId = '' } = {}) {
    if (profileId) {
      navigate(`/import-export/profiles/${profileId}/rule-suggestions`)
      return
    }
    if (batchId) {
      navigate(`/import-export/batches/${batchId}/rule-suggestions`)
      return
    }
    navigate('/import-export/rule-suggestions')
  }

  // The Group Imported Categories workspace's open/apply/delete logic now lives in
  // ImportedCategoryWorkspaceContext (App-level). This page keeps a categories-changed listener (below)
  // so its own `categories` copy refreshes after the workspace applies from anywhere.

  async function updateBatchImportedCategoryUsage(batchId, nextValue) {
    const existingBatch = batches.find(batch => batch.id === batchId)
    const normalizedSettings = normalizeImportedCategorySettings(
      extractImportedCategorySettings(existingBatch || {})
    )
    setBatches(prev => prev.map(batch => (
      batch.id === batchId
        ? { ...batch, use_imported_categories: nextValue }
        : batch
    )))
    try {
      await api.updateBatchImportedCategoryUsage(batchId, {
        use_imported_categories: nextValue,
        imported_category_scope_mode: normalizedSettings.scope_mode,
        imported_category_owner_ids: normalizedSettings.owner_ids,
        imported_category_unassigned_account_tokens: normalizedSettings.unassigned_account_tokens,
      })
      const [nextBatches, nextCategories] = await Promise.all([
        api.listBatches(),
        api.getCategories(),
      ])
      setBatches(nextBatches)
      setCategories(nextCategories)
    } catch (error) {
      setBatches(await api.listBatches())
      setNoticeDialog({
        title: 'Could not update that import',
        description: error?.message || 'Please try again.',
      })
    }
  }

  // The file card's "Enrich existing transactions from this source" toggle: on = fold every rejected
  // duplicate's novel detail into the transaction it matched (idempotent — ambiguous / nothing-new rows
  // are skipped); off = remove exactly what was folded in. Batch-scoped and retroactive, like the
  // imported-categories toggle above; the mapping screen's per-profile flag covers future imports.
  async function updateBatchEnrichment(batchId, nextValue) {
    try {
      if (nextValue) {
        const result = await api.enrichBatchDuplicates(batchId)
        if (!result?.enriched?.length) {
          setNoticeDialog({
            title: 'Nothing to enrich',
            description: "None of this file's rejected duplicates carried new detail for the transactions they matched.",
          })
        }
      } else {
        await api.undoBatchDuplicateEnrichment(batchId)
      }
      setBatches(await api.listBatches())
    } catch (error) {
      setNoticeDialog({
        title: 'Could not update enrichment',
        description: error?.message || 'Please try again.',
      })
    }
  }

  async function markBatchReviewed(batchId) {
    // Optimistically zero the card's count, then confirm against the server.
    setBatches(prev => prev.map(batch => (
      batch.id === batchId ? { ...batch, needs_review_count: 0 } : batch
    )))
    try {
      const result = await api.markBatchReviewed(batchId)
      const transactionIds = result?.transaction_ids || []
      setReviewUndo(transactionIds.length ? { batchId, transactionIds } : null)
      setBatches(await api.listBatches())
    } catch (error) {
      setBatches(await api.listBatches())
      setNoticeDialog({
        title: 'Could not mark that import reviewed',
        description: error?.message || 'Please try again.',
      })
    }
  }

  // Flags exactly the rows the sweep cleared, so one reviewed by hand before it stays reviewed.
  async function undoMarkBatchReviewed() {
    const snap = reviewUndo
    if (!snap) return
    setReviewUndo(null)
    try {
      await txnMutations.bulkUpdate(
        { mode: 'ids', ids: snap.transactionIds },
        [{ type: 'set_review_status', needs_review: true }],
      )
    } catch (error) {
      setNoticeDialog({
        title: 'Could not flag those transactions for review again',
        description: error?.message || 'Please try again.',
      })
    }
    setBatches(await api.listBatches())
  }

  // UndoToast keys its auto-dismiss timer on this callback, so it has to be stable.
  const closeReviewUndo = useCallback(() => setReviewUndo(null), [])

  function buildBatchImportedCategoryChoices(batch) {
    const ownerChoices = new Map()
    const accountChoices = new Map()
    const addOwnerChoice = (ownerId, ownerName, rowCount = 0) => {
      const normalizedId = String(ownerId || '').trim()
      if (!normalizedId) return
      const existing = ownerChoices.get(normalizedId)
      ownerChoices.set(normalizedId, {
        key: `owner:${normalizedId}`,
        kind: 'owner',
        ownerId: normalizedId,
        label: ownerName || 'Unnamed owner',
        rowCount: (existing?.rowCount || 0) + Number(rowCount || 0),
      })
    }
    const addAccountChoice = (token, label, rowCount = 0, sourceLabel = '') => {
      const normalizedToken = String(token || '').trim()
      if (!normalizedToken) return
      const existing = accountChoices.get(normalizedToken)
      accountChoices.set(normalizedToken, {
        key: `account:${normalizedToken}`,
        kind: 'account',
        token: normalizedToken,
        label,
        sourceLabel: existing?.sourceLabel || sourceLabel,
        rowCount: (existing?.rowCount || 0) + Number(rowCount || 0),
      })
    }

    for (const accountEntry of batch?.accounts || []) {
      if (accountEntry?.was_skipped) continue
      const rowCount = Number(accountEntry?.row_count || 0)
      const liveAccount = accounts.find(account => account.id === accountEntry.account_id)
      if (liveAccount?.owner_id) {
        addOwnerChoice(liveAccount.owner_id, liveAccount.owner_name || liveAccount.name, rowCount)
        continue
      }
      const token = accountEntry?.csv_value
        ? String(accountEntry.csv_value)
        : batch?.single_account_new?.name
          ? getNewAccountCategoryScopeToken(batch.single_account_new.name)
          : getFixedAccountCategoryScopeToken(accountEntry.account_id)
      addAccountChoice(token, liveAccount?.name || accountEntry?.account_name || accountEntry?.csv_value || 'Unassigned account', rowCount, accountEntry?.csv_value || '')
    }

    return [
      ...Array.from(ownerChoices.values()).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })),
      ...Array.from(accountChoices.values()).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })),
    ]
  }

  function openBatchImportedCategorySettings(batch) {
    setBatchImportedCategorySettingsDialog({
      batchId: batch.id,
      settings: extractImportedCategorySettings(batch),
      choices: buildBatchImportedCategoryChoices(batch),
    })
  }

  async function saveBatchImportedCategorySettings(batchId, settings) {
    const batch = batches.find(item => item.id === batchId)
    if (!batch) return
    const normalizedSettings = normalizeImportedCategorySettings(settings)
    setBatches(prev => prev.map(item => (
      item.id === batchId
        ? {
          ...item,
          imported_category_scope_mode: normalizedSettings.scope_mode,
          imported_category_owner_ids: normalizedSettings.owner_ids,
          imported_category_unassigned_account_tokens: normalizedSettings.unassigned_account_tokens,
        }
        : item
    )))
    try {
      await api.updateBatchImportedCategoryUsage(batchId, {
        use_imported_categories: !!batch.use_imported_categories,
        imported_category_scope_mode: normalizedSettings.scope_mode,
        imported_category_owner_ids: normalizedSettings.owner_ids,
        imported_category_unassigned_account_tokens: normalizedSettings.unassigned_account_tokens,
      })
      const [nextBatches, nextCategories] = await Promise.all([
        api.listBatches(),
        api.getCategories(),
      ])
      setBatches(nextBatches)
      setCategories(nextCategories)
      setBatchImportedCategorySettingsDialog(null)
    } catch (error) {
      setBatches(await api.listBatches())
      setNoticeDialog({
        title: 'Could not update category settings',
        description: error?.message || 'Please try again.',
      })
    }
  }

  function advancePastDataReview() {
    setShowRaw(false)
    landOnImport(importResult, [importResult.batch_id])
  }

  async function cancelTrailingDataReview() {
    const batchId = importResult?.batch_id
    if (!batchId) {
      setShowRaw(false)
      resetImport()
      return
    }
    const batch = batches.find(candidate => candidate.id === batchId)
      || { id: batchId, profile_id: selectedProfile || null }
    setLoading(true)
    try {
      await performBatchUndo(batch, false)
      setShowRaw(false)
      resetImport()
    } catch (error) {
      setNoticeDialog({
        title: 'Could not cancel that import',
        description: error?.message || 'Please try again.',
      })
    } finally {
      setLoading(false)
    }
  }

  // Opens the unified duplicate-detection report for a batch. The dialog is rendered at the
  // App level by `UnifiedDuplicatesViewerRenderer` so it persists across route navigation; this
  // thin wrapper just normalizes the file-card payload into the context's `open` contract.
  function openUnifiedDuplicatesViewer({ source, title }) {
    const batchId = source?.batch_id || source?.id || ''
    if (!batchId) return
    unifiedDuplicatesViewer.open({ batchId, title })
  }

  const landingNotice = landedImport ? (() => {
    // `result` is a CSV import's own; a landing without one (an Amazon import) brings its headline and
    // none of the prompts that follow from a mapped file.
    const { skipLines, usedImportedCategories } = landedImport
    const result = landedImport.result || {}
    // A single file's figures are read from its card once the batch list has it, so the notice and the
    // card beneath it cannot disagree (and a row imported from the duplicate report moves both).
    const landedBatch = result.multiFile ? null : batches.find(b => b.id === landedImport.batchIds[0])
    const summary = summarizeImportOutcome(landedBatch || result)
    const alreadyHeldCount = summary.dedupedCount + summary.ignoredCount
    // Lead with what actually happened. A file whose rows all duplicate existing history is a
    // *successful* import for an enrich-oriented source (a PayPal export duplicates what the bank
    // already shows; the value delivered is the detail folded into those matches) — so it says so
    // rather than reporting "0 transactions imported", which reads as a failure.
    const headline = landedImport.headline || (result.multiFile
      ? `${result.fileCount} file${result.fileCount === 1 ? '' : 's'} imported — ${result.imported} transaction${result.imported === 1 ? '' : 's'} added.`
      : summary.importedCount > 0
        ? `${summary.importedCount} transaction${summary.importedCount === 1 ? '' : 's'} imported.`
        : alreadyHeldCount > 0 && alreadyHeldCount === summary.totalRows
          ? 'No new transactions — every row was already in the ledger.'
          : 'No new transactions imported.')
    // Rows the file restated from the source's own earlier imports: a count and nothing to open, since
    // the transaction each one repeats is already the record. Said here as well as on the card because
    // it is most of what a routine overlapping export does, and the headline alone reads as a small file.
    const alreadyHeld = result.multiFile ? Number(result.ignored || 0) : summary.ignoredCount
    const heldNote = alreadyHeld > 0 && (result.multiFile || summary.importedCount > 0)
      ? ` ${formatCount(alreadyHeld)} row${alreadyHeld === 1 ? '' : 's'} already in the ledger.`
      : ''
    const calloutStyle = tone => ({
      marginTop: 12,
      padding: '12px 14px',
      borderRadius: 12,
      background: `color-mix(in srgb, var(--${tone}) 7%, var(--surface2))`,
      border: `1px solid color-mix(in srgb, var(--${tone}) 24%, var(--border))`,
    })
    return (
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 15 }}>
            <span style={{ fontWeight: 600 }}>✅ Import complete</span>
            <span style={{ color: 'var(--muted)' }}> — {headline}{heldNote}</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={importAnotherFile}>Import another file</Button>
            <Button variant="secondary" onClick={() => setLandedImport(null)}>Dismiss</Button>
          </div>
        </div>
        {skipLines.map((line, i) => (
          <div key={i} style={{ marginTop: 6, fontSize: 13, color: 'var(--muted)' }}>{line}</div>
        ))}
        {result.has_imported_categories ? (
          <div style={calloutStyle('accent')}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
              Categorized rows were imported with this file.
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
              {usedImportedCategories
                ? 'Because categories present in the data were used for this file, missing categories were added under Unassigned, the imported transactions kept those categories, and the file now contributes to system-wide rule suggestions.'
                : 'This file appears to already carry its own categories. If that data is clean and curated, check “Import the transactions with their existing categories” on its card below — that keeps those categories on the imported transactions and uses them to suggest rules. If only some accounts or owners are curated, you can scope it to just those.'}
            </div>
          </div>
        ) : null}
        {landedImport.result && !result.has_imported_categories && !hasAnyLeafCategory && !starterPromptDismissed ? (
          <div style={calloutStyle('accent2')}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
              Want to sort these into categories?
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55, marginBottom: 10 }}>
              Categories group transactions so the dashboard can report on them — groceries, utilities,
              dining, and so on. This file didn&apos;t bring its own, so you can start from a common set
              now, or skip it and build your own as you go. Nothing here is permanent.
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <Button
                disabled={addingStarterCats}
                onClick={async () => {
                  setAddingStarterCats(true)
                  try {
                    await api.generateStarterSet({ include_leaves: true })
                    await api.getCategories().then(setCategories).catch(() => { })
                    setStarterPromptDismissed(true)
                  } catch {
                    // Leave the prompt up so the user can retry.
                  } finally {
                    setAddingStarterCats(false)
                  }
                }}
              >
                {addingStarterCats ? 'Adding…' : 'Add starter categories'}
              </Button>
              <Button variant="secondary" onClick={() => setShowStarterRules(true)}>
                Add starter rules…
              </Button>
              <Button variant="secondary" onClick={() => setStarterPromptDismissed(true)}>
                Not now
              </Button>
            </div>
          </div>
        ) : null}
        {result.new_accounts_without_owner > 0 && (
          <div style={{ ...calloutStyle('accent2'), fontSize: 13 }}>
            {result.new_accounts_without_owner} new account{result.new_accounts_without_owner > 1 ? 's were' : ' was'} created without an owner.
            {' '}These accounts have no owner assigned — visit{' '}
            <Link to="/accounts" style={{ color: 'var(--accent2)', textDecoration: 'none' }}>
              Accounts
            </Link>
            {' '}to assign one.
          </div>
        )}
      </Card>
    )
  })() : null

  return (
    <div ref={tabTopRef} style={{ width: '100%', maxWidth: IMPORT_CONFIG_MAX_WIDTH }}>
      {amazonFiles ? (
        <AmazonImportDialog
          files={amazonFiles}
          sourceId={amazonSourceId}
          onClose={() => setAmazonFiles(null)}
          onImported={landOnAmazonImport}
        />
      ) : null}
      {paypalStatementFiles ? (
        <PaypalStatementImportDialog
          files={paypalStatementFiles}
          accounts={accounts}
          onClose={() => setPaypalStatementFiles(null)}
          // The import may have created the PayPal data source, whose cards show only once the page has it.
          onImported={async () => {
            const [nextProfiles, nextBatches] = await Promise.all([api.getImportProfiles(), api.listBatches()])
            handleManagerDataChange({ profiles: nextProfiles, batches: nextBatches })
          }}
          onAccountsChanged={async () => setAccounts(await api.getAccounts({ include_children: true }))}
        />
      ) : null}
      {noticeDialog ? (
        <AppNoticeDialog
          title={noticeDialog.title}
          description={noticeDialog.description}
          onClose={() => setNoticeDialog(null)}
        />
      ) : null}


      {pendingMappingSourceSwitch ? (
        <AppConfirmDialog
          title="Change data source?"
          description="Current mapping changes on this screen will be replaced."
          confirmLabel="Change data source"
          onConfirm={confirmMappingSourceSwitch}
          onCancel={() => setPendingMappingSourceSwitch(null)}
          width="min(500px, 100%)"
        />
      ) : null}

      {/* Naming a new data source is a deliberate create action: a focused dialog (Enter to create,
          Escape to cancel, backdrop inert) replaces the old inline boxes so the user can't leave a
          half-named source dangling, and only one can be open at a time. */}
      {showManualDraftSave ? (
        <AppTextEntryDialog
          title="Save as data source"
          description="Save the current import setup as a reusable data source."
          label="Data source name"
          value={manualDraftSaveName}
          onChange={setManualDraftSaveName}
          placeholder="Data source name"
          confirmLabel={savingManualDraftSource ? 'Creating…' : 'Create data source'}
          confirmDisabled={
            !manualDraftSaveName.trim()
            || savingManualDraftSource
            || (manualDraftSaveUseCurrent && !canCreateDataSourceFromCurrentMapping())
          }
          onConfirm={() => saveManualDraftAsDataSource({
            draftRecord: manualDraftSaveUseCurrent ? buildCurrentManualDraftRecord() : manualDraftRecord,
            activateAfterSave: manualDraftSaveActivate,
          })}
          onCancel={closeManualDraftSaveEditor}
          width="min(460px, 100%)"
        />
      ) : null}

      {assignNewSourceBatchId ? (
        <AppTextEntryDialog
          title="New data source from this file"
          description="Create a data source from this imported file and move the file under it."
          label="Data source name"
          value={assignNewSourceName}
          onChange={setAssignNewSourceName}
          placeholder="New data source name"
          confirmLabel="Create data source"
          confirmDisabled={!assignNewSourceName.trim()}
          onConfirm={() => createDataSourceFromUnknownBatch(
            batches.find(b => b.id === assignNewSourceBatchId),
            assignNewSourceName,
          )}
          onCancel={() => { setAssignNewSourceBatchId(''); setAssignNewSourceName('') }}
          width="min(460px, 100%)"
        />
      ) : null}

      {showRaw && preview && stage !== 'review-data' && (
        <RawFilePreview
          rawLines={rawViewerLines}
          headerRowIndex={preview.header_row_index ?? 0}
          lineNumberOffset={rawViewerOffset}
          title={rawViewerTitle}
          note={rawViewerNote}
          onClose={() => {
            setShowRaw(false)
            if (stage === 'review-rows' && importResult) landOnImport(importResult, [importResult.batch_id])
          }}
          onLoadMore={rawViewerSupportsLoadMore ? loadMoreRawLines : null}
          canLoadMore={rawViewerCanLoadMore}
          loadingMore={rawViewerLoadingMore}
        />
      )}

      {compatibleBatchPrompt ? (
        <CompatibleBatchAttachDialog
          prompt={compatibleBatchPrompt}
          attaching={attachingCompatibleBatches}
          onConfirm={attachCompatibleUnknownImports}
          onCancel={() => setCompatibleBatchPrompt(null)}
        />
      ) : null}

      {view === 'import' && demoLoadable ? (
        <Card style={{
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          border: '1px solid color-mix(in srgb, var(--accent) 26%, var(--border))',
          background: 'color-mix(in srgb, var(--accent) 6%, var(--surface))',
        }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>New here? Explore with demo data</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
              Load a sample dataset to see reports, categories, rules, and the duplicate-review workflow.
              You can clear it anytime from the banner that appears.
            </div>
          </div>
          {/* The load is genuinely slow — it runs a real import — so this label almost always earns its
              place; the gate is here for the case where it does not (a small dataset, a warm machine),
              where the flash would be all the user saw. `disabled` stays on the raw flag. */}
          <Button onClick={loadDemoFromImport} disabled={loadingDemo}>
            {busyDemo ? 'Loading…' : 'Load demo data'}
          </Button>
        </Card>
      ) : null}

      {/* The two ways data arrives, side by side: drop a file, or pull from a connection. They are the
          same intent and produce the same artifact — an import card in the history below. The connections
          card renders nothing until something is connected, and the row wraps once it cannot fit both. */}
      {view === 'import' && (
        <div style={{ display: 'flex', gap: 16, alignItems: 'stretch', flexWrap: 'wrap', marginBottom: 20 }}>
          <div style={{ flex: '1 1 340px', minWidth: 0 }}>
          <ImportUploadStage
            demoLoaded={demoLoaded}
            chooserOpen={sourceChooserOpen}
            // A dropped file's detected source is the mapping screen's to show, not the drop zone's behind it.
            hasSelectedSource={hasSelectedUploadSource && !importInProgress}
            onOpenChooser={() => setSourceChooserOpen(true)}
            onCloseChooser={() => setSourceChooserOpen(false)}
            uploadUsesManualDraft={uploadUsesManualDraft}
            uploadSelectionLabel={uploadSelectionLabel}
            profiles={profiles}
            selectedUploadSource={selectedUploadSource}
            selectUploadSource={selectUploadSource}
            editingSourceNameKey={editingSourceNameKey}
            getSourceNameEditKey={getSourceNameEditKey}
            sourceNameDraft={sourceNameDraft}
            setSourceNameDraft={setSourceNameDraft}
            saveSourceName={saveSourceName}
            setEditingSourceNameKey={setEditingSourceNameKey}
            showUploadSourceCreate={showUploadSourceCreate}
            setShowUploadSourceCreate={setShowUploadSourceCreate}
            uploadSourceDraftName={uploadSourceDraftName}
            setUploadSourceDraftName={setUploadSourceDraftName}
            createUploadDataSource={createUploadDataSource}
            dropRef={dropRef}
            fileInputRef={fileInputRef}
            handleDrop={handleDrop}
            handleFiles={handleFiles}
            loading={loading || !!filesAwaitingInitialData}
          />
          </div>
          <DataConnectionsPanel
            style={{ flex: '1 1 320px', minWidth: 0 }}
            batches={batches}
            onShowHistory={onShowHistory}
            onShowConnections={onShowConnections}
            onChanged={refreshBatches}
          />
        </div>
      )}

      {/* Below the two ways data arrives and at full page width: what it reports is work already
          waiting rather than another thing to start, but its height is the number of files waiting, so
          above them it pushed both off the top of the page. Here, an open list pushes down only the
          import history. Renders nothing at all until some source names a folder. */}
      {view === 'import' && (
        <WatchedFoldersPanel
          onOpenFile={(file, profileId) => handleFile(file, { sourceIdOverride: profileId })}
          onImported={() => api.listBatches().then(setBatches).catch(() => { })}
        />
      )}

      {/* Held while the unreadable-rows viewer, which floats above this, still needs the staged file. */}
      {stage === 'review-rows' ? <OverlayBackdrop zIndex={IMPORT_IN_PROGRESS_Z_INDEX} /> : null}

      {/* No way out but Import and Cancel (the × is Cancel): neither the backdrop nor Escape dismisses it. */}
      {stage === 'mapping' && preview && (
        <OverlayBackdrop zIndex={IMPORT_IN_PROGRESS_Z_INDEX} alignItems="flex-start">
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Import file"
          style={{
            width: 'min(948px, 100%)', maxHeight: '100%', display: 'flex', flexDirection: 'column',
            overflow: 'hidden', borderRadius: 16, background: 'var(--bg)', border: '1px solid var(--border)',
            boxShadow: '0 24px 60px rgba(15, 23, 42, 0.28)',
          }}
        >
        <FloatingPanelHeader style={{ padding: '16px 24px', flexShrink: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>
            {importFiles.length > 1 ? `Import ${importFiles.length} files` : 'Import file'}
          </div>
          <IconButton size="large" aria-label="Close" onClick={resetImport}>×</IconButton>
        </FloatingPanelHeader>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 24 }}>
        {/* The column is a child of the scrolling body, not the body itself: as flex items of a
            height-limited container the cards would shrink to fit it instead of scrolling. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, alignItems: 'flex-start' }}>
          {preview.previous_batch && (
            <div style={{ width: IMPORT_CONFIG_MAX_WIDTH, background: 'color-mix(in srgb, var(--warning) 12%, var(--surface2))', border: '1px solid var(--warning)', borderRadius: 8, padding: '12px 16px' }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>⚠️ This file has been previously imported</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>
                This exact file was imported on{' '}
                {preview.previous_batch?.imported_at?.slice(0, 16).replace('T', ' ')}.
                {colAccount
                  ? ' Accounts listed below were already imported from this file and cannot be imported again. Accounts not listed can still be imported now.'
                  : ' Undo the earlier import first before importing it again.'}
              </div>
              {previousImportAccounts.map(a => (
                <div key={a.account_id} style={{ fontSize: 13, marginBottom: 2 }}>• <strong>{a.account_name}</strong> — {a.row_count} transactions</div>
              ))}
              {colAccount && remainingAccountValues.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 10 }}>
                  All accounts in this file were already imported, so there is nothing left to import.
                </div>
              ) : null}
            </div>
          )}

          <Card style={{ width: IMPORT_CONFIG_MAX_WIDTH }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 0, flexWrap: 'wrap', marginBottom: 12 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>
                {preview.filename}
                <Button
                  size="compact"
                  variant="secondary"
                  pressed={showMappingSourceChooser}
                  onClick={() => setShowMappingSourceChooser(open => !open)}
                  title="Change data source"
                  style={{ marginLeft: 6 }}
                >
                  {selectedProfile ? (profiles.find(p => p.id === selectedProfile)?.name || 'Saved data source') : 'temporary draft'}
                </Button>
              </span>
              <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 13, marginLeft: 12 }}>
                {preview.total_rows} rows
              </span>
            </div>

            {showMappingSourceChooser ? (
              <div style={{ display: 'grid', gap: 10, marginBottom: 12, padding: '10px 12px', borderRadius: 12, border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 52%, var(--surface))' }}>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Choose a different data source for this file.
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                  <DataSourcePill
                    label="Temporary draft"
                    selected={!selectedProfile}
                    onClick={() => switchMappingDataSource(MANUAL_DATA_SOURCE_VALUE)}
                    title="Use a temporary draft for this file"
                  />
                  {profiles.map(profile => (
                    <DataSourcePill
                      key={profile.id}
                      label={profile.name}
                      selected={selectedProfile === profile.id}
                      onClick={() => switchMappingDataSource(profile.id)}
                      title="Use this saved data source"
                    />
                  ))}
                </div>
                <div>
                  <LinkButton tone="muted" onClick={returnToUploadSourceChooser} style={{ fontSize: 12 }}>
                    Start over
                  </LinkButton>
                </div>
              </div>
            ) : null}

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 0 }} />
              <Button size="compact" variant="secondary" pressed={showRaw} onClick={() => setShowRaw(v => !v)} style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
                {showRaw ? '× Close raw file' : '⌗ View raw file'}
              </Button>
              <LinkButton tone={showAdvanced ? undefined : 'muted'} aria-expanded={showAdvanced} onClick={() => setShowAdvanced(v => !v)} style={{ fontSize: 12, padding: '5px 4px', whiteSpace: 'nowrap', flexShrink: 0 }}>
                {showAdvanced ? '▴ Advanced' : '▾ Advanced'}
              </LinkButton>
            </div>

            {headerDetectedBeyondFirstLine && (
              <div style={{
                display: 'grid',
                gap: 12,
                marginBottom: 14,
                padding: '12px 14px',
                borderRadius: 10,
                background: 'color-mix(in srgb, var(--warning) 11%, var(--surface2))',
                border: '1px solid color-mix(in srgb, var(--warning) 48%, var(--border))',
                boxShadow: '0 8px 24px rgba(15, 23, 42, 0.12)',
              }}>
                <div style={{ display: 'grid', gap: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--warning)' }}>
                      Header located on line {detectedHeaderOffset + 1}
                    </span>
                    <span style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      minHeight: 22,
                      padding: '0 8px',
                      borderRadius: 999,
                      background: 'color-mix(in srgb, var(--warning) 18%, var(--surface))',
                      border: '1px solid color-mix(in srgb, var(--warning) 44%, var(--border))',
                      color: 'var(--warning)',
                      fontSize: 11,
                      fontWeight: 600,
                    }}>
                      Skipping {detectedHeaderOffset} row{detectedHeaderOffset === 1 ? '' : 's'} above it
                    </span>
                  </div>
                  <div style={{ fontSize: 12.5, color: 'color-mix(in srgb, var(--muted) 64%, var(--text))', lineHeight: 1.55 }}>
                    The preview below is already using that detected header row. Check that the column names look right. If they do not, review the raw file and adjust <strong style={{ color: 'var(--text)', fontWeight: 600 }}>Skip header rows</strong>.
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Button
                    variant="secondary"
                    pressed={showRaw}
                    onClick={() => setShowRaw(v => !v)}
                  >
                    {showRaw ? 'Hide raw file' : 'Review raw file'}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setShowAdvanced(v => !v)}
                  >
                    {showAdvanced ? 'Hide header controls' : 'Adjust header controls'}
                  </Button>
                </div>
              </div>
            )}

            {showAdvanced && (
              <div style={{
                display: 'flex', gap: 14, marginBottom: 14, flexWrap: 'wrap',
                padding: '10px 14px', background: 'var(--surface2)',
                borderRadius: 8, border: '1px solid var(--border)', alignItems: 'center',
              }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                  Date format
                  <select name="import-date-format" value={dateFormat} onChange={e => { setDateFormatLocked(true); setDateFormat(e.target.value) }} style={{
                    background: 'var(--surface)', color: 'var(--text)',
                    border: '1px solid var(--border)', borderRadius: 6,
                    padding: '3px 6px', fontSize: 12, cursor: 'pointer',
                  }}>
                    {DATE_FORMATS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                  Decimal separator
                  <select name="import-decimal-separator" value={decimalSeparator} onChange={e => { setDecimalSeparatorLocked(true); setDecimalSeparator(e.target.value) }} style={{
                    background: 'var(--surface)', color: 'var(--text)',
                    border: '1px solid var(--border)', borderRadius: 6,
                    padding: '3px 6px', fontSize: 12, cursor: 'pointer',
                  }}>
                    {DECIMAL_SEPARATORS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                  </select>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                  Amount format
                  <select name="import-amount-format" value={amtConv} onChange={e => setAmtConv(e.target.value)} style={{
                    background: 'var(--surface)', color: 'var(--text)',
                    border: '1px solid var(--border)', borderRadius: 6,
                    padding: '3px 6px', fontSize: 12, cursor: 'pointer',
                  }}>
                    {AMOUNT_CONVENTIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                  <FeatureExplainer topic="amount-conventions" placement="bottom-left" />
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                  Skip
                  <input name="import-skip-header-rows" type="number" min={0} max={10} value={displayedSkipRows}
                    onChange={e => {
                      const next = parseInt(e.target.value) || 0
                      setSkipRows(Math.max(0, next - detectedHeaderOffset))
                    }}
                    style={{
                      background: 'var(--surface)', color: 'var(--text)',
                      border: '1px solid var(--border)', borderRadius: 6,
                      padding: '3px 6px', fontSize: 12, width: 40, textAlign: 'center',
                    }}
                  />
                  header rows
                </label>
                {detectedHeaderOffset > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    Includes {detectedHeaderOffset} auto-detected row{detectedHeaderOffset !== 1 ? 's' : ''} before the header.
                  </div>
                )}
              </div>
            )}

            {(sourceColumnDelta.added.length > 0 || sourceColumnDelta.removed.length > 0) && (
              <div style={{
                marginBottom: 14,
                padding: '10px 12px',
                borderRadius: 8,
                background: 'color-mix(in srgb, var(--accent) 8%, var(--surface2))',
                border: '1px solid color-mix(in srgb, var(--accent2) 24%, var(--border))',
              }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent2)' }}>
                  The columns in this file are different from what is expected by the data source.
                </div>
                {sourceColumnDelta.added.length > 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
                    <span style={{ color: 'var(--text)', fontWeight: 600 }}>New:</span>{' '}
                    {sourceColumnDelta.added.join(', ')} — can be mapped, captured with{' '}
                    <span style={{ color: 'var(--text)' }}>Capture extra detail</span>, or ignored.
                  </div>
                ) : null}
                {sourceColumnDelta.removed.length > 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
                    <span style={{ color: 'var(--text)', fontWeight: 600 }}>No longer present:</span>{' '}
                    {sourceColumnDelta.removed.join(', ')} — any mapping that named one needs a new column.
                  </div>
                ) : null}
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                  The data source will be updated with the new header layout if the import completes.
                </div>
              </div>
            )}

            <ImportColumnMappingSection
              fields={[
                buildMappingFieldConfig({
                  key: 'date',
                  label: 'Date',
                  candidateHeaders: columnAnalysis.dateCandidates,
                  value: colDate,
                  required: true,
                  hint: dateSelectHint,
                  tone: selectedDateAnalysis && !selectedDateAnalysis.guessedFormat && selectedDateAnalysis.sampleCount ? 'danger' : 'muted',
                  onChange: handleDateColumnChange,
                  onAcceptSuggestion: handleDateColumnChange,
                }),
                amtConv === 'two_column'
                  ? buildMappingFieldConfig({
                    key: 'debit',
                    label: 'Debit column',
                    candidateHeaders: columnAnalysis.debitCandidates,
                    value: colDebit,
                    setValue: setColDebit,
                    required: true,
                  })
                  : buildMappingFieldConfig({
                    key: 'amount',
                    label: 'Amount',
                    candidateHeaders: columnAnalysis.amountCandidates,
                    value: colAmount,
                    setValue: setColAmount,
                    required: true,
                    hint: amountSelectHint,
                    tone: selectedAmountAnalysis && selectedAmountAnalysis.sampleCount > 0 && selectedAmountAnalysis.amountMatches === 0 ? 'danger' : 'muted',
                  }),
                buildMappingFieldConfig({
                  key: 'pending',
                  label: 'Pending',
                  candidateHeaders: columnAnalysis.pendingCandidates,
                  value: colPending,
                  setValue: setColPending,
                }),
                amtConv === 'two_column'
                  ? buildMappingFieldConfig({
                    key: 'credit',
                    label: 'Credit column',
                    candidateHeaders: columnAnalysis.creditCandidates,
                    value: colCredit,
                    setValue: setColCredit,
                    required: true,
                  })
                  : null,
                amtConv === 'single_unsigned'
                  ? buildMappingFieldConfig({
                    key: 'direction',
                    label: 'Debit/credit type column',
                    candidateHeaders: columnAnalysis.directionCandidates,
                    value: colDir,
                    setValue: setColDir,
                    hint: 'The column that says debit/credit (or deposit/withdrawal), e.g. a "Transaction Type" column.',
                  })
                  : null,
                buildMappingFieldConfig({
                  key: 'description',
                  label: 'Merchant',
                  candidateHeaders: columnAnalysis.merchantCandidates,
                  value: colDesc,
                  setValue: setColDesc,
                  required: true,
                }),
                buildMappingFieldConfig({
                  key: 'category',
                  label: 'Category',
                  candidateHeaders: columnAnalysis.categoryCandidates,
                  value: colCategory,
                  hint: categorySelectHint,
                  onChange: handleCategoryColumnChange,
                  onAcceptSuggestion: handleCategoryColumnChange,
                  after: colCategory && sourceCategoryValues.length > 0 ? (
                    <div style={{ position: 'absolute', width: 'calc(100% - 28px)', right: 0, top: 'calc(100% + 4px)', display: 'grid', justifyItems: 'end', gap: 6, zIndex: 1 }}>
                      {sourceCategoryMeta?.truncated ? (
                        <div style={{
                          padding: '7px 10px',
                          borderRadius: 12,
                          border: '1px solid color-mix(in srgb, var(--warning) 34%, var(--border))',
                          background: 'color-mix(in srgb, var(--warning) 10%, var(--surface2))',
                          color: 'color-mix(in srgb, var(--warning) 72%, var(--text))',
                          fontSize: 10.5,
                          lineHeight: 1.4,
                        }}>
                          This column has {sourceCategoryMeta.total_count} unique values. Showing the first {sourceCategoryMeta.limit}.
                        </div>
                      ) : null}
                    </div>
                  ) : null,
                }),
                buildMappingFieldConfig({
                  key: 'notes',
                  label: 'Notes',
                  candidateHeaders: columnAnalysis.notesCandidates,
                  value: colNotes,
                  setValue: setColNotes,
                }),
                // Last, with Notes, because it is the rarest column a file carries. No hint: what it had
                // to explain — a row in another currency is not imported — is already in the Import /
                // Export help topic and in `single-currency`, and a sentence long enough to say it
                // overflows a mapping cell.
                buildMappingFieldConfig({
                  key: 'currency',
                  label: 'Currency',
                  candidateHeaders: columnAnalysis.currencyCandidates,
                  value: colCurrency,
                  setValue: setColCurrency,
                }),
                // The identifier the source gives each row. What it makes possible — recognizing a row
                // already imported from this data source however its wording changed — is in the saved
                // data sources help topic; a mapping cell has no room to say it.
                buildMappingFieldConfig({
                  key: 'transaction_id',
                  label: 'Transaction ID',
                  candidateHeaders: columnAnalysis.transactionIdCandidates,
                  value: colTransactionId,
                  setValue: setColTransactionId,
                }),
              ]}
              accountField={{
                headers: columnAnalysis.accountCandidates,
                allHeaders: preview.headers,
                accounts,
                colAccount,
                accountId,
                singleAccountNew,
                suggestedColumn: mappingSuggestions.account,
                onAcceptSuggestedColumn: nextValue => {
                  clearMappingSuggestion('account')
                  setColAccount(nextValue)
                  setAccountMap({})
                  setAccountId('')
                  setSingleAccountNew({ enabled: false, name: '', type: 'depository' })
                },
                isRequired: !colAccount && !accountId && !singleAccountNew.enabled,
                hint: accountSelectHint,
                onChange: ({ col, acct, createNew }) => {
                  if (col !== undefined) {
                    if (col) clearMappingSuggestion('account')
                    setColAccount(col)
                    setAccountMap({})
                    setAccountId('')
                    setSingleAccountNew({ enabled: false, name: '', type: 'depository' })
                  } else {
                    if (acct || createNew) clearMappingSuggestion('account')
                    setColAccount(null)
                    setAccountMap({})
                    setAccountId(acct)
                    setSingleAccountNew(createNew
                      ? { enabled: true, name: '', type: 'depository' }
                      : { enabled: false, name: '', type: 'depository' })
                  }
                },
                onNewAccountChange: setSingleAccountNew,
              }}
            />
            <ImportEvidenceColumnsSection
              options={evidenceColumnOptions}
              checked={resolvedEvidenceColumns}
              forced={forcedEvidenceCols}
              newColumns={sourceColumnDelta.added}
              onChange={setEvidenceColumns}
            />

          </Card>

          {colAccount && distinctAccountValues.length > 0 && (
            <Card style={{ padding: 0, overflow: 'hidden', width: IMPORT_CONFIG_MAX_WIDTH }}>
              <AccountMappingGrid
                sourceHeading="Account from file"
                namePrefix="account-map"
                accounts={accounts}
                onUpdate={(csvVal, patch) => setAccountMap(prev => ({
                  ...prev,
                  [csvVal]: { ...defaultAccountMapEntry(csvVal), ...(prev[csvVal] || {}), ...patch },
                }))}
                inFlightOptions={inFlightNewAccounts.map(n => ({
                  value: n.name, label: `${n.name} (new)`, type: n.type,
                }))}
                rows={distinctAccountValues.map(csvVal => {
                  const alreadyImported = previousImportAccountsByValue.get(csvVal)
                  const skippedCount = Number(accountValueCounts[csvVal] || 0)
                  return {
                    key: csvVal,
                    label: csvVal,
                    entry: { ...defaultAccountMapEntry(csvVal), ...(accountMap[csvVal] || {}) },
                    candidates: accountMatchesByValue[csvVal]?.candidates || [],
                    suggestion: accountMatchesByValue[csvVal]?.likely || null,
                    details: alreadyImported ? (
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>
                        Already imported · {alreadyImported.row_count} rows
                      </div>
                    ) : null,
                    lockedNote: alreadyImported ? 'already imported' : null,
                    skipNote: `skipping ${skippedCount} transaction${skippedCount === 1 ? '' : 's'}`,
                  }
                })}
              />
            </Card>
          )}

          <Card style={{ padding: 0, overflow: 'hidden', width: IMPORT_CONFIG_MAX_WIDTH }}>
            <div style={{ padding: '10px 16px', fontSize: 13, fontWeight: 600, borderBottom: '1px solid var(--border)' }}>
              First {previewRows.length} transactions from file
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: `110px 1fr${colCategory ? ' 140px' : ''}${colAccount ? ' 130px' : ''} 100px`, padding: '7px 16px', fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)' }}>
              <span>Date</span><span>Merchant</span>
              {colCategory && <span>Category</span>}
              {colAccount && <span>Account</span>}
              <span style={{ textAlign: 'right' }}>Amount</span>
            </div>
            {previewRows.length === 0 ? (
              <div style={{ padding: '16px', fontSize: 13, color: 'var(--muted)', textAlign: 'center' }}>Map at least the date and description columns to see a preview</div>
            ) : previewRows.map(r => (
              <div key={r.i} style={{ display: 'grid', gridTemplateColumns: `110px 1fr${colCategory ? ' 140px' : ''}${colAccount ? ' 130px' : ''} 100px`, padding: '8px 16px', fontSize: 13, borderBottom: '1px solid var(--border)' }}>
                <span style={{ color: r.rawDate ? 'var(--text)' : 'var(--muted)', fontSize: 12 }}>{r.rawDate || <span style={{ opacity: 0.4 }}>—</span>}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.rawDesc || <span style={{ color: 'var(--muted)', opacity: 0.4 }}>—</span>}</span>
                {colCategory && <span style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.rawCat || <span style={{ opacity: 0.4 }}>—</span>}</span>}
                {colAccount && <span style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.rawAcct || <span style={{ opacity: 0.4 }}>—</span>}</span>}
                <span style={{ textAlign: 'right', fontWeight: 600, color: r.amount !== null ? getTransactionAmountColor(r.amount) : 'var(--danger)', fontSize: r.amount !== null ? 13 : 11 }}>
                  {r.amount !== null
                    ? formatTransactionAmount(r.amount)
                    : r.rawAmountStr
                      ? <span title={`Can't parse: "${r.rawAmountStr}"`} style={{ opacity: 0.6 }}>?{r.rawAmountStr.slice(0, 10)}</span>
                      : <span style={{ opacity: 0.4 }}>—</span>
                  }
                </span>
              </div>
            ))}
          </Card>

          <div style={{ display: 'grid', gap: 8, width: IMPORT_CONFIG_MAX_WIDTH }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
              <input name="apply-categorization-rules" type="checkbox" checked={applyCat} onChange={e => setApplyCat(e.target.checked)} />
              Apply categorization rules on import
            </label>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', fontSize: 13 }}>
              <input name="enrich-from-source" type="checkbox" checked={enrichFromSource} onChange={e => setEnrichFromSource(e.target.checked)} style={{ marginTop: 2 }} />
              <span>
                Enrich existing transactions from this source
                <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)' }}>
                  For existing transactions matched as duplicates, this indicates that additional details from this
                  source (memos, item titles) should be added to the transactions where they can be
                  used for building rules and other purposes. Enable for sources with rich detail.
                </span>
              </span>
            </label>
            <div style={{ display: 'grid', gap: 3 }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  cursor: colCategory ? 'pointer' : 'not-allowed',
                  fontSize: 13,
                  color: colCategory ? 'var(--text)' : 'var(--muted)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '8px 10px',
                  background: 'color-mix(in srgb, var(--surface2) 50%, transparent)',
                }}
                title={colCategory ? '' : 'Choose a category column before categories present in the data can be used'}
              >
                <input
                  name="use-imported-categories"
                  type="checkbox"
                  checked={useImportedCategories && !!colCategory}
                  disabled={!colCategory}
                  onChange={e => setUseImportedCategories(e.target.checked)}
                />
                <ImportedCategoryUsageInline
                  showFilter={useImportedCategories && colCategory && importedCategoryChoices.length > 1}
                  filterDisabled={!!getMappingDisabledReason()}
                  filterTitle={getMappingDisabledReason()}
                  onFilterClick={() => setShowImportedCategorySettings(true)}
                />
              </label>
              {useImportedCategories && colCategory && normalizeImportedCategorySettings(importedCategorySettings).scope_mode === IMPORTED_CATEGORY_SCOPE_FILTERED ? (
                <div style={{ paddingLeft: 26, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.35 }}>
                  {importedCategorySummary}
                </div>
              ) : null}
            </div>
            {!selectedProfile ? (
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span title={!canCreateDataSourceFromCurrentMapping() && !loading ? getCreateDataSourceDisabledReason() : ''}>
                  <Button
                    variant="secondary"
                    onClick={() => openManualDraftSaveEditor(
                      getSuggestedDataSourceName({
                        draftRecord: manualDraftRecord || buildCurrentManualDraftRecord(),
                        previewLike: preview,
                      }),
                      { activateAfterSave: true, useCurrentMapping: true },
                    )}
                    disabled={!canCreateDataSourceFromCurrentMapping() || loading}
                  >
                    Create data source
                  </Button>
                </span>
              </div>
            ) : null}
          </div>
        </div>
        </div>

          {/* The two ways out, pinned under the scrolling mapping so neither is a scroll away. */}
          <DialogActions style={{ flexShrink: 0, padding: '14px 24px' }}>
            <Button variant="secondary" onClick={resetImport}>Cancel</Button>
            <span title={!canImport() && !loading ? getImportDisabledReason() : ''}>
              <Button
                onClick={runImport}
                disabled={!canImport() || loading}
                progress={loading && importRowProgress
                  ? importRowProgress.done / Math.max(importRowProgress.total, 1)
                  : undefined}
              >
                {loading
                  ? formatImportingLabel(multiImportProgress, importRowProgress)
                  : (importFiles.length > 1
                    ? `Import ${importFiles.length} files`
                    : `Import ${importableRowCount} rows`)}
              </Button>
            </span>
          </DialogActions>
        </div>
        </OverlayBackdrop>
      )}

      {stage === 'review-data' && importResult && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: 'rgba(8, 12, 22, 0.72)',
            backdropFilter: 'blur(4px)',
            padding: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: 'min(980px, 100%)',
              display: 'flex',
              flexDirection: 'column',
              background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface) 88%, #0b1220), color-mix(in srgb, var(--surface2) 82%, #0f172a))',
              borderRadius: 16,
              border: '1px solid color-mix(in srgb, var(--accent2) 14%, var(--border))',
              boxShadow: '0 34px 90px rgba(2, 6, 23, 0.52)',
              overflow: 'hidden',
            }}
          >
            <div style={{
              padding: '18px 22px 12px',
              borderBottom: '1px solid var(--border)',
              background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 72%, #0f172a), color-mix(in srgb, var(--surface) 92%, #111827))',
            }}>
              <div style={{ display: 'flex', alignItems: 'start', justifyContent: 'space-between', gap: 16 }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>Review imported file tail</div>
                  <div style={{ fontSize: 13, color: 'color-mix(in srgb, var(--muted) 56%, #dbe6f7)', lineHeight: 1.55 }}>
                    The raw file viewer contains the start of what may be a trailer record. If the ending text is expected, choose Continue. If not, choose Cancel and nothing will be imported from the file.
                  </div>
                </div>
              </div>
            </div>
            <div style={{ padding: 22, display: 'grid', gap: 16, background: 'color-mix(in srgb, var(--surface) 90%, #0b1220)' }}>
              {preview && rawViewerLines?.length ? (
                <RawFilePreview
                  rawLines={rawViewerLines}
                  headerRowIndex={preview.header_row_index ?? 0}
                  lineNumberOffset={rawViewerOffset}
                  title={rawViewerTitle}
                  note={rawViewerNote}
                  embedded
                  embeddedHeight={300}
                  onLoadMore={rawViewerSupportsLoadMore ? loadMoreRawLines : null}
                  canLoadMore={rawViewerCanLoadMore}
                  loadingMore={rawViewerLoadingMore}
                />
              ) : null}
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <Button variant="secondary" onClick={cancelTrailingDataReview} disabled={loading}>
                  Cancel
                </Button>
                <Button onClick={advancePastDataReview} disabled={loading}>
                  Continue
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showStarterRules ? (
        <StarterRulesDialog
          onClose={() => setShowStarterRules(false)}
          onAdded={() => {
            api.getCategories().then(setCategories).catch(() => { })
            setStarterPromptDismissed(true)
          }}
        />
      ) : null}

      {view === 'sources' && (
        <>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <FeatureExplainer topic="unknown-data-source" placement="bottom-left" />
            <div style={{ fontSize: 16, fontWeight: 600 }}>Data sources</div>
          </div>
          <Card style={{ padding: 0, overflow: 'visible', width: '100%' }}>
            <ImportProfilesManager
              embedded
              hostData={managerHostData}
              onDataChange={handleManagerDataChange}
              onProfileCreated={handleManagerProfileCreated}
              onReviewMoneyMovement={reviewMoneyMovementForProfile}
              systemRows={<AmazonSourcesSection batches={batches} />}
            />
          </Card>
        </>
      )}

      {view === 'import' && (
        <ImportHistorySection
          dataSourceRows={dataSourceRows}
          profiles={profiles}
          focus={historyFocus}
          notice={landingNotice}
          expandedSourceRows={expandedSourceRows}
          setExpandedSourceRows={setExpandedSourceRows}
          openSystemCategoryWorkspace={openSystemCategoryWorkspace}
          totalSystemCategoryWorkspaceCount={totalSystemCategoryWorkspaceCount}
          pendingSystemCategoryCount={pendingSystemCategoryCount}
          openRuleSuggestionReview={openRuleSuggestionReview}
          hasSystemRuleSuggestionWork={hasSystemRuleSuggestionWork}
          pendingSystemRuleSuggestionCount={pendingSystemRuleSuggestionCount}
          manualDraftRecord={manualDraftRecord}
          openManualDraftSaveEditor={openManualDraftSaveEditor}
          setAssignNewSourceBatchId={setAssignNewSourceBatchId}
          setAssignNewSourceName={setAssignNewSourceName}
          assignUnknownBatchToProfile={assignUnknownBatchToProfile}
          updateBatchImportedCategoryUsage={updateBatchImportedCategoryUsage}
          updateBatchEnrichment={updateBatchEnrichment}
          buildBatchImportedCategoryChoices={buildBatchImportedCategoryChoices}
          openBatchImportedCategorySettings={openBatchImportedCategorySettings}
          openBatchDetail={openBatchDetail}
          markBatchReviewed={markBatchReviewed}
          handleUndoClick={openUndo}
          openUnifiedDuplicatesViewer={openUnifiedDuplicatesViewer}
          openReconciliationViewer={reconciliationViewer.open}
          renameConnection={renameConnection}
        />
      )}

      {pendingProfileMismatch ? (
        <DataSourceMismatchDialog
          profileName={pendingProfileMismatch.profileName}
          chooserOpen={showProfileMismatchChooser}
          profiles={profiles}
          selectedProfileId={showProfileMismatchChooser ? pendingProfileMismatch.profileId : ''}
          fileHeaderFingerprint={pendingProfileMismatch.previewLike?.header_fingerprint || ''}
          onSelectProfile={handleProfileMismatchSelectSource}
          onSelectTemporaryDraft={() => handleProfileMismatchSelectSource(MANUAL_DATA_SOURCE_VALUE)}
          onCloseChooser={handleProfileMismatchChooserBack}
          onConfirm={handleProfileMismatchConfirm}
          onCancel={handleProfileMismatchCancel}
          onChangeDataSource={handleProfileMismatchChangeDataSource}
        />
      ) : null}

      {pendingSourceMatchChoice ? (
        <MultipleSourceMatchDialog
          matches={pendingSourceMatchChoice.matches}
          fileHeaderFingerprint={pendingSourceMatchChoice.previewLike?.header_fingerprint || ''}
          onSelectProfile={handleSourceMatchChoice}
          onSelectTemporaryDraft={() => handleSourceMatchChoice(MANUAL_DATA_SOURCE_VALUE)}
          onCancel={cancelSourceMatchChoice}
        />
      ) : null}

      {multiSourceChoice ? (
        <MultiFileSourceChooserDialog
          groups={multiSourceChoice.groups}
          unreadable={multiSourceChoice.unreadable}
          onPickGroup={group => startGroupImport(group, { unreadable: multiSourceChoice.unreadable })}
          onCancel={() => setMultiSourceChoice(null)}
        />
      ) : null}

      {moneyMovementReview ? (
        <MoneyMovementReviewDialog
          proposals={moneyMovementReview.proposals}
          editing={!!moneyMovementReview.editing}
          applying={moneyMovementApplying}
          onApply={applyMoneyMovementRules}
          onOpenReport={(type, alreadyRuled) => setMoneyMovementReport({ type, alreadyRuled })}
          onClose={() => setMoneyMovementReview(null)}
        />
      ) : null}

      {moneyMovementReport && moneyMovementReview ? (
        <MoneyMovementTypeReportPanel
          type={moneyMovementReport.type}
          alreadyRuled={!!moneyMovementReport.alreadyRuled}
          accountIds={moneyMovementReview.accountIds || []}
          categories={categories}
          onClose={() => setMoneyMovementReport(null)}
        />
      ) : null}

      {showImportedCategorySettings ? (
        <ImportedCategorySettingsDialog
          title={IMPORTED_CATEGORY_FILTER_DIALOG_TITLE}
          description={IMPORTED_CATEGORY_FILTER_DIALOG_DESCRIPTION}
          choices={importedCategoryChoices}
          initialSettings={importedCategorySettings}
          onSave={settings => {
            setImportedCategorySettings(settings)
            setShowImportedCategorySettings(false)
          }}
          onCancel={() => setShowImportedCategorySettings(false)}
        />
      ) : null}

      {batchImportedCategorySettingsDialog ? (
        <ImportedCategorySettingsDialog
          title={IMPORTED_CATEGORY_FILTER_DIALOG_TITLE}
          description={IMPORTED_CATEGORY_FILTER_DIALOG_DESCRIPTION}
          choices={batchImportedCategorySettingsDialog.choices}
          initialSettings={batchImportedCategorySettingsDialog.settings}
          onSave={settings => saveBatchImportedCategorySettings(batchImportedCategorySettingsDialog.batchId, settings)}
          onCancel={() => setBatchImportedCategorySettingsDialog(null)}
        />
      ) : null}

      {undoNode}
      {panelsNode}
      {reviewUndo ? (
        // Keyed on the card so each sweep restarts the countdown rather than inheriting the last.
        <UndoToast
          key={reviewUndo.batchId}
          title="Marked reviewed"
          description={`${reviewUndo.transactionIds.length} transaction${reviewUndo.transactionIds.length === 1 ? '' : 's'} no longer need${reviewUndo.transactionIds.length === 1 ? 's' : ''} review.`}
          onUndo={undoMarkBatchReviewed}
          onDismiss={closeReviewUndo}
        />
      ) : null}
    </div>
  )
}

// Amazon order import: upload one or both AZAD exports (orders + items), pick or create the account the
// items land in, and run the parse→apply pipeline. Files are sniffed server-side, so either file alone is
// accepted; the result panel reports the per-disposition + orphan counts the backend returns. The account
// control follows the "creating is available wherever assigning is" rule (inline create). The drop zone is
// a small local control, not the CSV `ImportUploadStage`, which is coupled to the data-source /
// header-fingerprint flow this import does not use.
const IMPORT_TABS = [['import', 'Data Import'], ['sources', 'File Sources']]
const IMPORT_TAB_STORAGE_KEY = 'import.activeTab'
// `?tab=history` is the Data Import tab under the name it had while the history was a tab of its own.
const tabFromLink = value => (value === 'history' ? 'import' : IMPORT_TABS.some(([id]) => id === value) ? value : null)
// `?tab=connections` is the Connections tab from when it was on this page. A remembered startup route or a
// bookmark can still carry it, so it is sent on to where that tab is now.
const movedTabRoute = value => (value === 'connections' ? CONNECTIONS_ROUTE : null)

export default function ImportExport() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const movedTo = movedTabRoute(searchParams.get('tab'))
  // Active in-page tab, session-scoped as on the Accounts page (sticks while the app is open, resets to
  // Data Import next launch). `?tab=` is how a link from elsewhere (a Tasks entry, the welcome flow)
  // lands on a particular tab, and takes precedence on arrival.
  const [tab, setTabState] = useState(() => {
    const fromUrl = tabFromLink(searchParams.get('tab'))
    if (fromUrl) return fromUrl
    const stored = sessionStore.get(IMPORT_TAB_STORAGE_KEY)
    return IMPORT_TABS.some(([id]) => id === stored) ? stored : 'import'
  })
  const setTab = useCallback((next) => {
    setTabState(next)
    sessionStore.set(IMPORT_TAB_STORAGE_KEY, next)
  }, [])
  // What the import history is being opened *on*: `{ batchIds, connectionIds }` naming the cards a
  // finished import, a sync, or a "to review" pill is about, which the Data Import tab opens, scrolls to
  // and marks. `token` makes each landing a distinct event, so landing on the same card twice scrolls
  // twice. Choosing a tab by hand is not a landing and clears it.
  const [historyFocus, setHistoryFocus] = useState(null)
  const focusToken = useRef(0)
  const showInHistory = useCallback((focus = null) => {
    focusToken.current += 1
    setHistoryFocus(focus ? { ...focus, token: focusToken.current } : null)
    setTab('import')
  }, [setTab])
  const chooseTab = useCallback((id) => { setHistoryFocus(null); setTab(id) }, [setTab])
  const showFileImport = useCallback(() => chooseTab('import'), [chooseTab])
  const showConnections = useCallback(() => navigate(CONNECTIONS_ROUTE), [navigate])
  // Honor a `?tab=` link followed while the page is already mounted, then strip it so it neither lingers
  // in the URL nor overrides later manual tab switches. A link to the Data Import tab may name its
  // landing with `batch=` or `connection=` (comma-separated ids).
  useEffect(() => {
    if (movedTo) {
      navigate(movedTo, { replace: true })
      return
    }
    if (!searchParams.get('tab')) return
    const fromUrl = tabFromLink(searchParams.get('tab'))
    if (fromUrl === 'import') {
      const batchIds = (searchParams.get('batch') || '').split(',').filter(Boolean)
      const connectionIds = (searchParams.get('connection') || '').split(',').filter(Boolean)
      showInHistory(batchIds.length || connectionIds.length ? { batchIds, connectionIds } : null)
    } else if (fromUrl) {
      chooseTab(fromUrl)
    }
    const next = new URLSearchParams(searchParams)
    next.delete('tab')
    next.delete('batch')
    next.delete('connection')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams, showInHistory, chooseTab, movedTo, navigate])
  if (movedTo) return null
  return (
    <div data-browser-context-passthrough="true" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '32px 32px 0', flexShrink: 0 }}>
        <PageHeader title="Import" help={<FeatureExplainer topic="page-import-export" placement="bottom-left" />} />
        {/* Outside the scroll area, so the tabs stay put while a tab's content scrolls. */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)' }}>
          {IMPORT_TABS.map(([id, label]) => (
            <button key={id} onClick={() => chooseTab(id)} style={{ padding: '8px 24px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 14, color: tab === id ? 'var(--text)' : 'var(--muted)', borderBottom: tab === id ? '2px solid var(--accent)' : '2px solid transparent', fontWeight: tab === id ? 500 : 400 }}>{label}</button>
          ))}
        </div>
      </div>
      <div data-browser-context-passthrough="true" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 32px 32px' }}>
        {/* The gap under the tab row belongs to the content, not to the scroll area: a pinned block sticks
            to the scroll area's padding edge, so padding here would leave a strip above it that the
            history scrolls through. */}
        <div style={{ paddingTop: 24 }}>
        {/* One mount for both tabs: they are two views of one state. */}
        {(tab === 'import' || tab === 'sources') && (
          <ImportErrorBoundary>
            <ImportTab view={tab} historyFocus={historyFocus} onShowHistory={showInHistory} onShowImport={showFileImport} onShowConnections={showConnections} />
          </ImportErrorBoundary>
        )}
        </div>
      </div>
    </div>
  )
}
