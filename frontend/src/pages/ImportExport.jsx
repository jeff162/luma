// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import React, { useCallback, useState, useEffect, useRef, useMemo } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api.js'
import { useBusyIndicator } from '../lib/useBusyIndicator.js'
import { sniffAmazonExportKind } from '../lib/amazonDetect.js'
import { PaypalStatementImportDialog } from '../components/importExport/PaypalStatementImportDialog.jsx'
import {
  Card,
  PageHeader,
  Button,
  Select,
  Input,
  Spinner,
  Badge,
  Toggle,
  AppConfirmDialog,
  AppNoticeDialog,
  AppTextEntryDialog,
  getFloatingPanelHeaderBackground,
  getFloatingPanelSurfaceStyle,
} from '../components/ui.jsx'
import CategoryPicker from '../components/CategoryPicker.jsx'
import DropZone from '../components/DropZone.jsx'
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
import AccountMatchSelect from '../components/importExport/AccountMatchSelect.jsx'
import {
  DataSourceMismatchDialog,
  MultipleSourceMatchDialog,
  MultiFileSourceChooserDialog,
  CompatibleBatchAttachDialog,
  DuplicateImportConfirmDialog,
  PossibleAccountMatchChooserDialog,
} from '../components/importExport/importConfirmDialogs.jsx'
import { ImportedCategorySettingsDialog } from '../components/importExport/ImportedCategorySettingsDialog.jsx'
import { RejectedRowsDialog } from '../components/importExport/RejectedRowsDialog.jsx'
import { DuplicateRowsDialog } from '../components/importExport/DuplicateRowsDialog.jsx'
import { RawFilePreview } from '../components/importExport/RawFilePreview.jsx'
import { ExportTab } from '../components/importExport/ExportTab.jsx'
import { BackupRestoreTab } from '../components/importExport/BackupRestoreTab.jsx'
import { ImportUploadStage } from '../components/importExport/ImportUploadStage.jsx'
import WatchedFoldersPanel from '../components/importExport/WatchedFoldersPanel.jsx'
import { MoneyMovementReviewDialog } from '../components/importExport/MoneyMovementReviewDialog.jsx'
import { MoneyMovementTypeReportPanel } from '../components/importExport/MoneyMovementTypeReportPanel.jsx'
import { useBatchUndo } from '../components/importExport/useBatchUndo.jsx'
import { useBatchDetailPanels } from '../components/importExport/useBatchDetailPanels.jsx'
import { ImportHistorySection } from '../components/importExport/ImportHistorySection.jsx'
import { ConnectionSyncLogDialog } from '../components/connections/ConnectionSyncLogDialog.jsx'
import { DataConnectionsPanel } from '../components/connections/DataConnectionsPanel.jsx'
import { MarketplaceImportHistory } from '../components/importExport/MarketplaceImportHistory.jsx'
import { useUnifiedDuplicatesViewer } from '../contexts/UnifiedDuplicatesViewerContext.jsx'
import { useSyncStatus } from '../contexts/SyncStatusContext.jsx'
import { useReconciliationViewer } from '../contexts/ReconciliationViewerContext.jsx'
import { byCoverage } from '../lib/importExport/importHistoryWindow.js'
import { ImportDetailStorageDialog } from '../components/importExport/ImportDetailStorageDialog.jsx'
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
  findProfilesMatchingPreview,
  groupFilesBySource,
  unionPreviewColumnValues,
} from '../lib/importExport/importDraft.js'
import {
  summarizeImportOutcome,
  getUndoTargetForSource,
  buildMultiFileResult,
  formatSkippedImportMessage,
} from '../lib/importExport/importOutcome.js'
import { countPendingRuleSuggestions, hasRuleSuggestionWork } from '../lib/importExport/ruleSuggestionWork.js'
import {
  analyzeImportColumns,
  computeEvidenceColumnOptions,
  defaultEvidenceColumns,
  forcedEvidenceColumns,
  formatLikelyMatchLabel,
  inferFilenamePattern,
  inferImportFileCharacteristicsFromPreview,
  inferUnambiguousImportMappingFromPreview,
} from '../lib/importColumnInference.js'
import ImportEvidenceColumnsSection from '../components/ImportEvidenceColumnsSection.jsx'
import { formatTransactionAmount, getTransactionAmountColor } from '../lib/moneyDisplay.js'
import { useAppSession } from '../lib/AppSessionContext.jsx'
import { useUserPreference } from '../lib/UserPreferencesContext.jsx'
import { GENERIC_IMPORT_ACCOUNT_TYPES, isMarketplaceAccountType } from '../lib/accountTypes.js'
import {
  IMPORT_DEFAULT_CATEGORY_USAGE_MODE_PREF_KEY,
  IMPORT_CATEGORY_USAGE_MODE_PER_SOURCE,
} from '../lib/appConfig.js'
import {
  AMOUNT_CONVENTIONS,
  DATE_FORMATS,
  IMPORT_CONFIG_MAX_WIDTH,
  MANUAL_DATA_SOURCE_VALUE,
  EXPANDED_IMPORT_SOURCE_ROWS_PREF_KEY,
  DATA_SOURCE_MANAGER_POS_PREF_KEY,
  AMAZON_IMPORT_ACCOUNT_PREF_KEY,
  DEMO_IMPORT_DISABLED_MESSAGE,
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
import {
  guessNewAccountTypeFromName,
  findExactAccountNameMatch,
  getAccountMatchLabel,
  findAccountMatchCandidates,
  findLikelyAccountMatch,
  buildAccountImportStateSnapshot,
} from '../lib/importExport/importAccountMatching.js'

function clampFloatingPanelPosition(pos, size, viewport = { width: window.innerWidth, height: window.innerHeight }) {
  if (!pos) return null
  const panelWidth = Number(size?.width || 0)
  const panelHeight = Number(size?.height || 0)
  const maxX = Math.max(24, viewport.width - panelWidth - 24)
  const maxY = Math.max(24, viewport.height - panelHeight - 24)
  return {
    x: Math.max(24, Math.min(maxX, Math.round(pos.x))),
    y: Math.max(24, Math.min(maxY, Math.round(pos.y))),
  }
}

// `UnifiedDuplicatesDialog` lives at the App level so it can stay open while the user navigates
// between Import/Export, Accounts, Transactions, etc. — see
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
  const rows = rowProgress ? `${rowProgress.done.toLocaleString()} / ${rowProgress.total.toLocaleString()}` : null
  if (fileProgress) {
    return rows
      ? `File ${fileProgress.current}/${fileProgress.total} · ${rows}…`
      : `Importing ${fileProgress.current}/${fileProgress.total}…`
  }
  return rows ? `Importing ${rows}…` : 'Importing…'
}

// Keep the import UI recoverable if a preview or mapping render crashes.
function ImportTab({ onAmazonDetected, syncLogConnectionId = '' }) {
  const navigate = useNavigate()
  const { dbInstanceId, preferenceSubjectId, demoLoaded } = useAppSession()
  const [defaultImportCategoryUsageMode] = useUserPreference(IMPORT_DEFAULT_CATEGORY_USAGE_MODE_PREF_KEY, IMPORT_CATEGORY_USAGE_MODE_PER_SOURCE)
  const [expandedSourceRows, setExpandedSourceRows] = useUserPreference(EXPANDED_IMPORT_SOURCE_ROWS_PREF_KEY, {})
  const [savedDataSourceManagerPos, setSavedDataSourceManagerPos] = useUserPreference(DATA_SOURCE_MANAGER_POS_PREF_KEY, null)
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
  const [showDataSourceManager, setShowDataSourceManager] = useState(false)
  const [showDetailStorage, setShowDetailStorage] = useState(false)
  const [dataSourceManagerInitialMode, setDataSourceManagerInitialMode] = useState('list')
  const [dataSourceManagerEditing, setDataSourceManagerEditing] = useState(false)
  const [dataSourceManagerPos, setDataSourceManagerPos] = useState(null)
  const [dataSourceManagerDragging, setDataSourceManagerDragging] = useState(false)
  const [editingSourceNameKey, setEditingSourceNameKey] = useState('')
  const [sourceNameDraft, setSourceNameDraft] = useState('')
  const [editingSourceDescriptionId, setEditingSourceDescriptionId] = useState('')
  const [sourceDescriptionDraft, setSourceDescriptionDraft] = useState('')

  const [selectedProfile, setSelectedProfile] = useState('')
  const [accountId, setAccountId] = useState('')
  const [dateFormat, setDateFormat] = useState('%m/%d/%Y')
  const [amtConv, setAmtConv] = useState('single_signed')
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
  const [pendingAccountMatchChooser, setPendingAccountMatchChooser] = useState(null)
  const [categoryAssignments, setCategoryAssignments] = useState({})
  const [importResult, setImportResult] = useState(null)
  // Post-import categorization nudge: shown on the done screen when an import brought no categories and
  // the user hasn't started categorizing yet (no leaf categories). It self-suppresses once they engage.
  const [showStarterRules, setShowStarterRules] = useState(false)
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
  const [rejectedRowsViewer, setRejectedRowsViewer] = useState(null)
  const [duplicateRowsViewer, setDuplicateRowsViewer] = useState(null)
  // Unified duplicates viewer state was lifted to UnifiedDuplicatesViewerContext so the floating
  // report can survive route changes. We hold onto the context handles here to open it and to
  // know when it has reloaded (so the file-card pill counts can be refreshed in step).
  const unifiedDuplicatesViewer = useUnifiedDuplicatesViewer()
  const reconciliationViewer = useReconciliationViewer()
  // Shared per-batch file-ledger panels (the `↗`). This tab keeps its own drill-through / URL openers
  // below, which call `openBatchDetail`.
  // The sync log opens as a report rather than standing on the page: it is read on the specific occasion
  // that a sync brought in less than expected, and a diagnostic nobody needs most of the time should not
  // occupy a screenful of a page people come to for importing files. A `?connection=` deep link from a
  // connection's menu opens it straight away, scoped to that connection.
  const [syncLogOpen, setSyncLogOpen] = useState(!!syncLogConnectionId)

  const { openBatchDetail, panelsNode } = useBatchDetailPanels({
    categories,
    onAddCategory: category => setCategories(prev => prev.some(existing => existing.id === category.id) ? prev : [...prev, category]),
    // Reconcile the file card's "N to review" pill when the batch-detail panel reports how many rows
    // still need review after the user categorized/reviewed some inside it.
    onReviewCountChange: (batchId, count) => setBatches(prev => prev.map(batch => (
      batch.id === batchId && batch.needs_review_count !== count ? { ...batch, needs_review_count: count } : batch
    ))),
  })
  const [duplicateImporting, setDuplicateImporting] = useState(false)
  const [pendingDuplicateImport, setPendingDuplicateImport] = useState(null)
  const [pendingProfileMismatch, setPendingProfileMismatch] = useState(null)
  const [showProfileMismatchChooser, setShowProfileMismatchChooser] = useState(false)
  const [pendingMappingSourceSwitch, setPendingMappingSourceSwitch] = useState(null)
  const [noticeDialog, setNoticeDialog] = useState(null)
  // Per-batch "+ New data source from this file" inline name entry (unknown-source cards).
  const [assignNewSourceBatchId, setAssignNewSourceBatchId] = useState('')
  const [assignNewSourceName, setAssignNewSourceName] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [dateFormatLocked, setDateFormatLocked] = useState(false)
  const duplicateViewerRequestRef = useRef(0)
  const dataSourceManagerRef = useRef(null)
  const dataSourceManagerDragStartRef = useRef(null)

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
  useEffect(() => { setStarterPromptDismissed(false) }, [importResult?.batch_id])
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
  }, [location.search, batches, navigate, openBatchDetail])

  // `?review=paypal` is the Tasks entry's way into the PayPal reconciliation, which is about the whole
  // ledger rather than one file. Honored once on arrival, then cleaned from the URL like the one above.
  const openReconciliation = reconciliationViewer.open
  useEffect(() => {
    if (new URLSearchParams(location.search).get('review') !== 'paypal') return
    openReconciliation({ vendor: 'paypal', title: '' })
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
  const { runsFinished } = useSyncStatus()
  const handledRunsRef = useRef(runsFinished)
  useEffect(() => {
    if (runsFinished === handledRunsRef.current) return
    handledRunsRef.current = runsFinished
    api.listBatches().then(setBatches).catch(() => { })
  }, [runsFinished])

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

  function getDataSourceManagerDefaultPosition() {
    if (typeof window === 'undefined') return { x: 360, y: 180 }
    const width = Math.min(1040, window.innerWidth - 96)
    const height = Math.max(380, Math.min(window.innerHeight * 0.78, 640))
    return clampFloatingPanelPosition(
      {
        x: Math.max(340, Math.round(window.innerWidth * 0.24)),
        y: 180,
      },
      { width, height },
    )
  }

  function closeDataSourceManager() {
    setShowDataSourceManager(false)
    setDataSourceManagerInitialMode('list')
    setDataSourceManagerEditing(false)
    setDataSourceManagerDragging(false)
  }

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

  function startDataSourceManagerDrag(event) {
    if (dataSourceManagerEditing || !dataSourceManagerRef.current) return
    const rect = dataSourceManagerRef.current.getBoundingClientRect()
    dataSourceManagerDragStartRef.current = {
      mouseX: event.clientX,
      mouseY: event.clientY,
      x: dataSourceManagerPos?.x ?? rect.left,
      y: dataSourceManagerPos?.y ?? rect.top,
      width: rect.width,
      height: rect.height,
    }
    setDataSourceManagerDragging(true)
    event.preventDefault()
  }

  useEffect(() => {
    if (!showDataSourceManager) return
    const saved = savedDataSourceManagerPos && typeof savedDataSourceManagerPos === 'object'
      ? savedDataSourceManagerPos
      : null
    const rect = dataSourceManagerRef.current?.getBoundingClientRect()
    const nextPos = saved
      ? clampFloatingPanelPosition(saved, rect || { width: Math.min(1040, window.innerWidth - 96), height: Math.max(380, Math.min(window.innerHeight * 0.78, 640)) })
      : getDataSourceManagerDefaultPosition()
    setDataSourceManagerPos(nextPos)
  }, [savedDataSourceManagerPos, showDataSourceManager])

  useEffect(() => {
    if (!showDataSourceManager) return undefined
    function handleResize() {
      const rect = dataSourceManagerRef.current?.getBoundingClientRect()
      setDataSourceManagerPos(prev => clampFloatingPanelPosition(prev || getDataSourceManagerDefaultPosition(), rect || { width: Math.min(1040, window.innerWidth - 96), height: Math.max(380, Math.min(window.innerHeight * 0.78, 640)) }))
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [showDataSourceManager])

  useEffect(() => {
    if (!dataSourceManagerDragging) return undefined
    function handleMove(event) {
      const start = dataSourceManagerDragStartRef.current
      if (!start) return
      setDataSourceManagerPos(clampFloatingPanelPosition({
        x: start.x + (event.clientX - start.mouseX),
        y: start.y + (event.clientY - start.mouseY),
      }, { width: start.width, height: start.height }))
    }
    function handleUp() {
      setDataSourceManagerDragging(false)
      const start = dataSourceManagerDragStartRef.current
      if (!start) return
      setSavedDataSourceManagerPos(prev => {
        const next = dataSourceManagerPos || prev || getDataSourceManagerDefaultPosition()
        return next
      }).catch(() => { })
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [dataSourceManagerDragging, dataSourceManagerPos, setSavedDataSourceManagerPos])

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

  const dataSourceRows = useMemo(() => {
    const savedSourceRows = profiles.map(profile => {
      // Cards run by the period they cover (`byCoverage`); `latestBatch` stays the most recently
      // imported, since "Last used" is a fact about the source rather than about its newest data.
      const profileBatches = batches.filter(batch => batch.profile_id === profile.id).sort(byCoverage)
      const latestBatch = [...profileBatches].sort((a, b) => String(b.imported_at || '').localeCompare(String(a.imported_at || '')))[0] || null
      return {
        key: `profile:${profile.id}`,
        kind: 'profile',
        profile,
        hasImportedCategories: profileBatches.some(batch => batch.has_imported_categories),
        batches: profileBatches,
        latestBatch,
      }
    })
    // Marketplace imports (Amazon, …) carry `source_kind` of `marketplace:<vendor>` and never have a CSV
    // profile; they group under their own vendor entry rather than the "unknown data source" bucket.
    const isMarketplaceBatch = batch => typeof batch.source_kind === 'string' && batch.source_kind.startsWith('marketplace:')
    const marketplaceByVendor = new Map()
    for (const batch of batches) {
      if (batch.profile_id || !isMarketplaceBatch(batch)) continue
      const vendor = batch.source_kind.split(':')[1] || 'marketplace'
      if (!marketplaceByVendor.has(vendor)) marketplaceByVendor.set(vendor, [])
      marketplaceByVendor.get(vendor).push(batch)
    }
    for (const [vendor, vendorBatches] of marketplaceByVendor) {
      const byImport = vendorBatches.sort((a, b) => String(b.imported_at || '').localeCompare(String(a.imported_at || '')))
      // Cards ordered by the data they cover; latestBatch stays the most recently imported so
      // "Last used" is unaffected.
      savedSourceRows.push({
        key: `marketplace:${vendor}`,
        kind: 'marketplace',
        vendor,
        label: vendor.charAt(0).toUpperCase() + vendor.slice(1),
        profile: null,
        hasImportedCategories: byImport.some(b => b.has_imported_categories),
        batches: [...byImport].sort(byCoverage),
        latestBatch: byImport[0],
        manualDraftRecord: null,
      })
    }

    // Data-source sync cards (source_kind 'connection_sync', no CSV profile): one history row per
    // connection, its per-(connection, month) period cards as the expandable batches — grouped like a
    // marketplace vendor so synced rows get the same per-card duplicate/review affordances as an imported
    // file. The card filename is "<institution> · <Month Year>"; the institution prefix labels the row.
    const isConnectionSyncBatch = batch => batch.source_kind === 'connection_sync'
    const connectionLabelFromFilename = filename => {
      const [prefix] = String(filename || '').split(' · ')
      return (prefix || '').trim() || 'Connection'
    }
    // A card whose connection is gone keeps its history on purpose — `connection_id` is ON DELETE SET
    // NULL, because these cards are the provenance of transactions still in the ledger and outlive the
    // credential that fetched them. What they must not do is pile into one bucket: keyed together, a
    // group takes its name from whichever orphan is newest and files every other source under it, so a
    // SimpleFIN import ends up sitting beneath a bank's name. Each card still carries its own identity in
    // the filename prefix, so that is what they are grouped by instead.
    const connectionGroups = new Map()
    for (const batch of batches) {
      if (!isConnectionSyncBatch(batch)) continue
      const key = batch.connection_id
        || `disconnected:${connectionLabelFromFilename(batch.filename)}`
      if (!connectionGroups.has(key)) connectionGroups.set(key, [])
      connectionGroups.get(key).push(batch)
    }
    for (const [groupKey, connBatches] of connectionGroups) {
      const byImport = connBatches.sort((a, b) => String(b.imported_at || '').localeCompare(String(a.imported_at || '')))
      const byPeriod = [...byImport].sort(byCoverage)
      // Absent for a disconnected group, which is what tells the row it is history rather than a live
      // connection — there is no connection left for its actions to act on.
      const connectionId = byImport[0]?.connection_id || null
      savedSourceRows.push({
        key: `connection:${groupKey}`,
        kind: 'connection',
        connectionId,
        disconnected: !connectionId,
        // Prefer the connection's own institution/provider (real fields) over parsing them out of the
        // card filename; the filename parse stays as a fallback for older cards created before the
        // provenance was plumbed through — and it is the only source for a disconnected group, whose
        // connection row is gone along with the fields it carried.
        label: byImport[0]?.connection_institution || connectionLabelFromFilename(byImport[0]?.filename),
        provider: byImport[0]?.connection_provider || null,
        profile: null,
        hasImportedCategories: false,
        batches: byPeriod,
        latestBatch: byImport[0],
        // The connection's own last sync, which is what "recent" means for it. The newest card's imported_at
        // is only when that card was created — a monthly card keeps receiving rows for weeks afterwards.
        // Null once disconnected, when the connection's record is gone.
        lastSyncedAt: byImport[0]?.connection_last_synced_at || null,
        manualDraftRecord: null,
      })
    }

    const manualBatches = batches
      .filter(batch => !batch.profile_id && !batch.unknown_source_fallback && !isMarketplaceBatch(batch) && !isConnectionSyncBatch(batch))
      .sort((a, b) => String(b.imported_at || '').localeCompare(String(a.imported_at || '')))
    const fallbackUnknownBatches = batches
      .filter(batch => !batch.profile_id && batch.unknown_source_fallback && !isMarketplaceBatch(batch) && !isConnectionSyncBatch(batch))
      .sort((a, b) => String(b.imported_at || '').localeCompare(String(a.imported_at || '')))
    const latestManualBatch = manualBatches[0] || null
    const olderManualBatches = manualBatches.slice(1)

    if (latestManualBatch) {
      savedSourceRows.push({
        key: 'manual-draft',
        kind: 'manual',
        profile: null,
        hasImportedCategories: !!latestManualBatch?.has_imported_categories,
        batches: [latestManualBatch],
        latestBatch: latestManualBatch,
        manualDraftRecord,
      })
    }

    const unknownSourceBatches = [
      ...olderManualBatches,
      ...fallbackUnknownBatches,
    ].sort(byCoverage)

    if (unknownSourceBatches.length > 0) {
      savedSourceRows.push({
        key: 'unknown-source',
        kind: 'unknown',
        profile: null,
        hasImportedCategories: unknownSourceBatches.some(batch => batch.has_imported_categories),
        batches: unknownSourceBatches,
        latestBatch: [...unknownSourceBatches].sort((a, b) => String(b.imported_at || '').localeCompare(String(a.imported_at || '')))[0],
        manualDraftRecord: null,
      })
    }
    // A connection is as recent as its last sync; everything else as its newest import. The two timestamps are
    // written in different shapes (`2026-09-12T13:23:40Z` against `2026-09-12 13:23:40`, both UTC), so the
    // separator is normalized before comparing, or every same-day sync would sort after every same-day import.
    const recency = row => String((row.kind === 'connection' && row.lastSyncedAt) || row.latestBatch?.imported_at || '').replace('T', ' ')
    return savedSourceRows.sort((a, b) => {
      const priority = row => row.kind === 'manual' ? 0 : 1
      const priorityDiff = priority(a) - priority(b)
      if (priorityDiff !== 0) return priorityDiff
      return recency(b).localeCompare(recency(a))
    })
  }, [profiles, batches, manualDraftRecord])

  const columnAnalysis = useMemo(() => analyzeImportColumns(preview, skipRows), [preview, skipRows])

  // The capture panel: unmapped columns with an inferred shape + default. `resolvedEvidenceColumns` is
  // what actually gets captured — the user's explicit picks, or the derived default when untouched —
  // filtered to columns still present and unmapped so a stale pick can't leak through.
  const mappedHeaders = useMemo(
    () => [colDate, colAmount, colDebit, colCredit, colDir, colDesc, colCategory, colNotes, colPending, colCurrency, colAccount].filter(Boolean),
    [colDate, colAmount, colDebit, colCredit, colDir, colDesc, colCategory, colNotes, colPending, colCurrency, colAccount],
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

  useEffect(() => {
    if (!pendingAccountMatchChooser) return
    const stillExists = distinctAccountValues.includes(pendingAccountMatchChooser.csvValue)
    // At least one candidate must survive. `some`, not `every`: an account deleted underneath the dialog
    // should drop out of the question, not cancel a question the remaining candidates can still answer.
    const targetStillExists = pendingAccountMatchChooser.candidates
      .some(candidate => accounts.some(account => account.id === candidate.id))
    if (!stillExists || !targetStillExists) {
      setPendingAccountMatchChooser(null)
    }
  }, [pendingAccountMatchChooser, distinctAccountValues, accounts])

  // Opened with the whole candidate set, not one account: the dialog is where those are shown, and
  // "Keep separate" asserts distinctness from all of them. A caller re-entering to revisit an existing
  // grouping passes the single account it is about, which arrives as a one-entry list and pre-selects.
  function openAccountMatchChooser(csvValue, targets) {
    const candidates = (Array.isArray(targets) ? targets : [targets]).filter(Boolean)
    if (!csvValue || !candidates.length) return
    setPendingAccountMatchChooser({
      csvValue,
      candidates: candidates.map(target => ({
        id: target.id,
        label: getAccountMatchLabel(target) || target.name || csvValue,
        institution: target.institution || '',
      })),
    })
  }

  // `selectedId` is which candidate the two relationship answers act on; `keep_separate` ignores it and
  // reads the whole list instead, because declining is an answer about all of them.
  function applyAccountMatchChoice(choice, selectedId) {
    const pending = pendingAccountMatchChooser
    if (!pending?.csvValue) return
    const csvValue = pending.csvValue
    const ruledOut = pending.candidates.map(c => c.id)
    const targetAccount = accounts.find(account => account.id === selectedId)
    setPendingAccountMatchChooser(null)
    if (choice !== 'keep_separate' && !targetAccount) return
    setAccountMap(prev => {
      const defaultEntry = {
        accountId: '',
        createNew: false,
        newName: csvValue,
        newType: targetAccount?.type || guessNewAccountTypeFromName(csvValue),
        groupWithAccountId: '',
        skip: false,
      }
      const current = { ...defaultEntry, ...(prev[csvValue] || {}) }
      if (choice === 'map_existing' && targetAccount) {
        return {
          ...prev,
          [csvValue]: {
            ...current,
            accountId: targetAccount.id,
            createNew: false,
            newName: targetAccount.name || csvValue,
            newType: targetAccount.type || current.newType || 'depository',
            groupWithAccountId: '',
            skip: false,
          },
        }
      }
      if (choice === 'group_with_existing' && targetAccount) {
        return {
          ...prev,
          [csvValue]: {
            ...current,
            accountId: '',
            createNew: true,
            newName: current.newName || csvValue,
            newType: current.newType || targetAccount.type || 'depository',
            groupWithAccountId: targetAccount.id,
            skip: false,
          },
        }
      }
      // keep_separate. The one branch that records an *answer* rather than a relationship: the user has
      // looked at both account names and said they are different accounts, which is exactly the
      // assertion the cross-account duplicate sweep needs. Discarding it meant the same question came
      // back one flagged transaction at a time as soon as the rows landed.
      return {
        ...prev,
        [csvValue]: {
          ...current,
          accountId: '',
          createNew: true,
          newName: current.newName || csvValue,
          newType: current.newType || guessNewAccountTypeFromName(csvValue),
          groupWithAccountId: '',
          skip: false,
          distinctFromAccountIds: ruledOut,
        },
      }
    })
  }

  const hasImportWorkToSave = !!(
    colDate || colAmount || colDebit || colCredit || colDir || colDesc || colCategory || colNotes || colPending || colCurrency ||
    colAccount || accountId || singleAccountNew.enabled || Object.keys(accountMap).length > 0 ||
    Object.keys(categoryAssignments).length > 0 || skipRows > 0 || dateFormat !== '%m/%d/%Y' ||
    amtConv !== 'single_signed' || !applyCat || useImportedCategories ||
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
    preview, hasImportWorkToSave, selectedProfile, accountId, dateFormat, amtConv, skipRows, applyCat, useImportedCategories, importedCategorySettings,
    colDate, colAmount, colDebit, colCredit, colDir, colDesc, colCategory, colNotes, colPending, colCurrency, colAccount,
    singleAccountNew, accountMap, categoryAssignments,
  ])

  useEffect(() => {
    if (!colDate || dateFormatLocked) return
    const guessedFormat = columnAnalysis.dateAnalysisByHeader[colDate]?.guessedFormat
    if (guessedFormat && guessedFormat !== dateFormat) {
      setDateFormat(guessedFormat)
    }
  }, [colDate, columnAnalysis.dateAnalysisByHeader, dateFormat, dateFormatLocked])

  const previewSourceRows = useMemo(
    () => (preview?.rows ? preview.rows.slice(skipRows) : []),
    [preview?.rows, skipRows],
  )

  // Amounts are parsed by the backend, not here — see lib/importExport/previewAmounts.js for why the
  // client owns no amount parsing.
  const previewAmounts = usePreviewAmounts(previewSourceRows, amtConv, {
    amount: colAmount, debit: colDebit, credit: colCredit, direction: colDir,
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
    accountMap, accountId, dateFormat, amtConv, skipRows,
    applyCat, enrichFromSource, useImportedCategories, importedCategorySettings, singleAccountNew,
    colDate, colAmount, colDebit, colCredit, colDir, colDesc, colCategory, colNotes, colPending, colCurrency, colAccount,
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
    setColAccount(null)
    setEvidenceColumns(null)
    applyInferredMappingSuggestions(inferredMapping)
    setAccountMap({})
    setCategoryAssignments({})
    setSingleAccountNew({ enabled: false, name: '', type: 'depository' })
  }

  function resetToInferredImportMapping(profileId, previewLike = preview) {
    resetToSuggestedImportMapping(profileId, previewLike)
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
    const existingSingleAccount = cm.single_account_new?.name
      ? findExactAccountNameMatch(accounts, cm.single_account_new.name)
      : null
    const existingAssignedAccount = p.account_id
      ? accounts.find(a => a.id === p.account_id)
      : null
    setAccountId(existingSingleAccount ? existingSingleAccount.id : (existingAssignedAccount?.id || '')); setDateFormat(p.date_format || '%m/%d/%Y')
    setDateFormatLocked(true)
    setAmtConv(p.amount_convention || 'single_signed'); setSkipRows(p.skip_rows || 0)
    setApplyCat(!!p.apply_categorization)
    setEnrichFromSource(!!p.enrich_from_source)
    setUseImportedCategories(!!p.use_imported_categories)
    setImportedCategorySettings(extractImportedCategorySettings(p))
    setColDate(cm.date || null); setColAmount(cm.amount || null); setColDebit(cm.debit || null)
    setColCredit(cm.credit || null); setColDir(cm.direction || null)
    setColDesc(cm.description || null); setColCategory(cm.category || null); setColNotes(cm.notes || null); setColPending(cm.pending || null); setColCurrency(cm.currency || null)
    setMappingSuggestions(buildProfileMappingSuggestions(previewLike, {
      skipRowsValue: p.skip_rows || 0,
      amountConvention: p.amount_convention || 'single_signed',
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
        account: cm.account || '',
      },
    }))
    setCategoryAssignments(cm.category_assignments || {})
    setSingleAccountNew(cm.single_account_new && !existingSingleAccount
      ? { enabled: true, name: cm.single_account_new.name || '', type: cm.single_account_new.type || 'depository' }
      : { enabled: false, name: '', type: 'depository' })
    const newColAccount = cm.account || null
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
    setSkipRows(snap.skip_rows || 0); setApplyCat(snap.apply_categorization !== false)
    setEnrichFromSource(!!snap.enrich_from_source)
    setUseImportedCategories(!!snap.use_imported_categories)
    setImportedCategorySettings(extractImportedCategorySettings(snap))
    setColDate(cm.date || null); setColAmount(cm.amount || null); setColDebit(cm.debit || null)
    setColCredit(cm.credit || null); setColDir(cm.direction || null)
    setColDesc(cm.description || null); setColCategory(cm.category || null); setColNotes(cm.notes || null); setColPending(cm.pending || null); setColCurrency(cm.currency || null); setColAccount(cm.account || null)
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
    // flow (which owns the account choice + linking) instead of the column-mapping path.
    if (onAmazonDetected) {
      const head = await file.slice(0, 16384).text().catch(() => '')
      if (sniffAmazonExportKind(head.split(/\r?\n/, 1)[0])) {
        onAmazonDetected([file])
        return
      }
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
    // Route any AZAD Amazon exports to the Amazon flow (which already accepts multiple); the rest are CSV.
    let csvFiles = otherFiles
    if (onAmazonDetected) {
      const amazon = []
      csvFiles = []
      for (const file of otherFiles) {
        const head = await file.slice(0, 16384).text().catch(() => '')
        if (sniffAmazonExportKind(head.split(/\r?\n/, 1)[0])) amazon.push(file)
        else csvFiles.push(file)
      }
      if (amazon.length) onAmazonDetected(amazon)
    }
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
    resetToInferredImportMapping(profileId, previewLike)

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
      direction: colDir, description: colDesc, category: colCategory, notes: colNotes, pending: colPending, currency: colCurrency, account: colAccount,
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
        const mapping = accountMap[value]
        if (!mapping) {
          unresolvedCount += 1
          singleMessage = `Choose an account for "${value}".`
          continue
        }
        if (mapping.skip) continue
        if (mapping.createNew) {
          const name = mapping.newName.trim()
          if (!name) {
            unresolvedCount += 1
            singleMessage = `Enter a new account name for "${value}".`
            continue
          }
          if (!mapping.newType) {
            unresolvedCount += 1
            singleMessage = `Choose an account type for "${value}".`
            continue
          }
          if (accounts.some(a => a.name.toLowerCase() === name.toLowerCase())) {
            unresolvedCount += 1
            singleMessage = `Select the existing account "${name}" instead of creating a duplicate.`
          }
          continue
        }
        if (!mapping.accountId) {
          unresolvedCount += 1
          singleMessage = `Choose an account for "${value}".`
        }
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
        // Each file landed as its own card in the history below; summarize and return to the upload
        // screen rather than the single-file review (whose per-file dialogs don't apply to an aggregate).
        // If a PayPal money-movement review takes over (the actionable follow-up), skip the summary
        // notice so two dialogs don't stack — the per-file counts remain on the history cards.
        const reviewOpened = await maybeOpenMoneyMovementReview(result)
        const skipped = result.skipped || []
        const parts = [`${result.imported} transaction${result.imported === 1 ? '' : 's'} added`]
        if (result.deduped) parts.push(`${result.deduped} duplicate row${result.deduped === 1 ? '' : 's'} skipped`)
        if (result.enriched_count) parts.push(`${result.enriched_count} enriched`)
        if (result.rejected_count) parts.push(`${result.rejected_count} row${result.rejected_count === 1 ? '' : 's'} rejected`)
        const importedLine = result.fileCount > 0
          ? `${parts.join(', ')}. Each file is a separate card below — open one for its per-file detail.`
          : ''
        const skipLines = skipped.map(formatSkippedImportMessage)
        const totalSelected = result.fileCount + skipped.length
        if (!reviewOpened) {
          setNoticeDialog({
            title: skipped.length
              ? `Imported ${result.fileCount} of ${totalSelected} files`
              : `Imported ${result.fileCount} files`,
            description: (
              <>
                {importedLine ? <div>{importedLine}</div> : null}
                {skipLines.map((line, i) => (
                  <div key={i} style={{ marginTop: (importedLine || i) ? 6 : 0 }}>{line}</div>
                ))}
              </>
            ),
          })
        }
        resetImport()
      } else {
        setStage(result.trailing_non_transaction_suspected ? 'review-data' : 'done')
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
    setShowDataSourceManager(false)
    setDataSourceManagerInitialMode('list')
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

  async function saveSourceDescription(profileId) {
    const nextValue = sourceDescriptionDraft.trim()
    setProfiles(prev => prev.map(item => (
      item.id === profileId
        ? { ...item, filename_pattern: nextValue || null }
        : item
    )))
    setEditingSourceDescriptionId('')
    setSourceDescriptionDraft('')
    try {
      await api.updateImportProfile(profileId, { filename_pattern: nextValue || null })
    } catch (error) {
      api.getImportProfiles().then(setProfiles)
      setNoticeDialog({
        title: 'Could not save the data source description',
        description: error?.message || 'Please try again.',
      })
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
    const cm = { ...existingProfileMap, ...getColumnMap() }
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

  // Returning to the upload stage re-renders the drop zone at the top of the page, but the scroll
  // position stays wherever the triggering control was (e.g. the "Import another file" button down by
  // the result card with several file cards open above it), leaving the picker off-screen. When a reset
  // is meant to put the user back at the picker, arm this so the effect below scrolls it into view once
  // the upload stage has mounted.
  const uploadStageRef = useRef(null)
  const scrollToUploadOnMount = useRef(false)
  useEffect(() => {
    if (stage === 'upload' && scrollToUploadOnMount.current) {
      scrollToUploadOnMount.current = false
      uploadStageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [stage])

  // Same problem at the other end of the flow: finishing an import leaves the scroll position wherever
  // the Import button was — typically far down the mapping screen — and the newly-expanded source row
  // adds file cards above it, so the result lands off-screen and the import reads as if nothing happened.
  // Bring the summary into view once it has mounted. Keyed on the batch id so importing a second file
  // scrolls again rather than only on the first transition into `done`.
  const doneStageRef = useRef(null)
  useEffect(() => {
    if (stage === 'done' && importResult?.batch_id) {
      doneStageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [stage, importResult?.batch_id])

  function importAnotherFile() {
    scrollToUploadOnMount.current = true
    resetImport()
  }

  function resetImport() {
    setStage('upload'); setPreview(null); setImportResult(null)
    setAccountMap({})
    setRejectedRowsViewer(null)
    setDuplicateRowsViewer(null)
    setDuplicateImporting(false)
    setColPending(null)
    setColCurrency(null)
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
      await api.markBatchReviewed(batchId)
      setBatches(await api.listBatches())
    } catch (error) {
      setBatches(await api.listBatches())
      setNoticeDialog({
        title: 'Could not mark that import reviewed',
        description: error?.message || 'Please try again.',
      })
    }
  }

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
    setStage('done')
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

  // The live import's own rejected rows, on the done screen, where the file is still staged and the
  // raw-file hand-off below is therefore still possible. A *saved* batch's rows are not shown here —
  // they are a tab on the file's report (`ImportBatchNotImported`), which holds every class of
  // refusal rather than the three this summary carries, and outlives the session.
  function openRejectedRowsViewer({
    source,
    title,
    allowRawViewer = false,
  }) {
    const summary = summarizeImportOutcome(source)
    if (summary.rejectedCount <= 0) return
    setRejectedRowsViewer({
      headers: summary.rejectedHeaders,
      rows: summary.rejectedRows,
      count: summary.rejectedCount,
      title,
      allowRawViewer,
    })
  }

  // Opens the unified duplicate-detection report for a batch. The dialog is rendered at the
  // App level by `UnifiedDuplicatesViewerRenderer` so it persists across route navigation; this
  // thin wrapper just normalizes the file-card payload into the context's `open` contract.
  function openUnifiedDuplicatesViewer({ source, title }) {
    const batchId = source?.batch_id || source?.id || ''
    if (!batchId) return
    unifiedDuplicatesViewer.open({ batchId, title })
  }

  async function openDuplicateRowsViewer({
    source,
    title,
  }) {
    const summary = summarizeImportOutcome(source)
    if (summary.dedupedCount <= 0) return
    const batchId = source?.batch_id || source?.id || ''
    if (!batchId) return
    const requestId = duplicateViewerRequestRef.current + 1
    duplicateViewerRequestRef.current = requestId
    try {
      const result = await api.getBatchDuplicates(batchId)
      if (duplicateViewerRequestRef.current !== requestId) return
      setDuplicateRowsViewer({
        batchId,
        headers: Array.isArray(result.headers) ? result.headers : [],
        rows: Array.isArray(result.rows) ? result.rows : [],
        count: Number(result.count || summary.dedupedCount) || 0,
        title,
        loading: false,
        error: '',
      })
    } catch (error) {
      if (duplicateViewerRequestRef.current !== requestId) return
      setDuplicateRowsViewer({
        batchId,
        headers: [],
        rows: [],
        count: summary.dedupedCount,
        title,
        loading: false,
        error: error?.message || 'Could not load duplicate rows.',
      })
    }
  }

  async function syncDuplicateImportState(batchId) {
    const refreshedBatches = await api.listBatches()
    setBatches(refreshedBatches)
    const updatedBatch = refreshedBatches.find(item => item.id === batchId) || null
    if (updatedBatch && importResult?.batch_id === batchId) {
      const updatedSummary = summarizeImportOutcome(updatedBatch)
      setImportResult(prev => prev ? {
        ...prev,
        imported: updatedSummary.importedCount,
        deduped: updatedSummary.dedupedCount,
        duplicate_count: updatedSummary.dedupedCount,
        import_summary: updatedBatch.import_summary,
      } : prev)
    }
    if (!updatedBatch) {
      setDuplicateRowsViewer(null)
      return
    }
    const updatedSummary = summarizeImportOutcome(updatedBatch)
    if (updatedSummary.dedupedCount > 0) {
      setDuplicateRowsViewer(prev => prev ? {
        ...prev,
        count: updatedSummary.dedupedCount,
        loading: true,
        error: '',
      } : prev)
      try {
        const result = await api.getBatchDuplicates(batchId)
        setDuplicateRowsViewer(prev => prev ? {
          ...prev,
          headers: Array.isArray(result.headers) ? result.headers : [],
          rows: Array.isArray(result.rows) ? result.rows : [],
          count: Number(result.count || updatedSummary.dedupedCount) || 0,
          loading: false,
          error: '',
        } : prev)
      } catch (error) {
        setDuplicateRowsViewer(prev => prev ? {
          ...prev,
          headers: [],
          rows: [],
          loading: false,
          error: error?.message || 'Could not refresh duplicate rows.',
        } : prev)
      }
    } else {
      setDuplicateRowsViewer(null)
    }
  }

  async function importSelectedDuplicates(batchId, rowNumbers = [], importAll = false) {
    if (!batchId) return
    setDuplicateImporting(true)
    try {
      const result = await api.importBatchDuplicates(batchId, {
        import_all: importAll,
        row_numbers: importAll ? null : rowNumbers,
      })
      await syncDuplicateImportState(batchId)
      if (result.not_importable_count > 0) {
        setNoticeDialog({
          title: 'Some duplicate rows could not be imported',
          description: `${result.not_importable_count} selected duplicate row${result.not_importable_count === 1 ? '' : 's'} could not be imported from this saved batch.`,
        })
      }
    } catch (error) {
      setNoticeDialog({
        title: 'Could not import duplicate rows',
        description: error?.message || 'Please try again.',
      })
    } finally {
      setDuplicateImporting(false)
    }
  }

  function requestDuplicateImportConfirmation(batchId, rowNumbers = [], importAll = false, count = 0) {
    if (!batchId) return
    if (!importAll && (!Array.isArray(rowNumbers) || rowNumbers.length === 0)) return
    setPendingDuplicateImport({
      batchId,
      rowNumbers,
      importAll,
      count: importAll ? Number(count || 0) : rowNumbers.length,
    })
  }

  async function confirmDuplicateImport() {
    if (!pendingDuplicateImport) return
    const current = pendingDuplicateImport
    setPendingDuplicateImport(null)
    await importSelectedDuplicates(current.batchId, current.rowNumbers, current.importAll)
  }

  return (
    <div style={{ width: '100%', maxWidth: IMPORT_CONFIG_MAX_WIDTH }}>
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
          onClose={() => setShowRaw(false)}
          onLoadMore={rawViewerSupportsLoadMore ? loadMoreRawLines : null}
          canLoadMore={rawViewerCanLoadMore}
          loadingMore={rawViewerLoadingMore}
        />
      )}

      {rejectedRowsViewer ? (
        <RejectedRowsDialog
          headers={rejectedRowsViewer.headers}
          rows={rejectedRowsViewer.rows}
          count={rejectedRowsViewer.count}
          title={rejectedRowsViewer.title}
          onClose={() => setRejectedRowsViewer(null)}
          onOpenRawViewer={rejectedRowsViewer.allowRawViewer ? () => {
            setRejectedRowsViewer(null)
            setShowRaw(true)
          } : undefined}
        />
      ) : null}

      {duplicateRowsViewer ? (
        <DuplicateRowsDialog
          headers={duplicateRowsViewer.headers}
          rows={duplicateRowsViewer.rows}
          count={duplicateRowsViewer.count}
          title={duplicateRowsViewer.title}
          loading={!!duplicateRowsViewer.loading}
          error={duplicateRowsViewer.error || ''}
          importing={duplicateImporting}
          onClose={() => setDuplicateRowsViewer(null)}
          onImportSelected={rowNumbers => requestDuplicateImportConfirmation(duplicateRowsViewer.batchId, rowNumbers, false, rowNumbers.length)}
          onImportAll={() => requestDuplicateImportConfirmation(duplicateRowsViewer.batchId, [], true, duplicateRowsViewer.count)}
        />
      ) : null}

      {pendingDuplicateImport ? (
        <DuplicateImportConfirmDialog
          pending={pendingDuplicateImport}
          importing={duplicateImporting}
          onCancel={() => setPendingDuplicateImport(null)}
          onConfirm={confirmDuplicateImport}
        />
      ) : null}

      {compatibleBatchPrompt ? (
        <CompatibleBatchAttachDialog
          prompt={compatibleBatchPrompt}
          attaching={attachingCompatibleBatches}
          onConfirm={attachCompatibleUnknownImports}
          onCancel={() => setCompatibleBatchPrompt(null)}
        />
      ) : null}

      {stage === 'upload' && demoLoadable ? (
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

      {/* The two ways data arrives, side by side and equally weighted: drop a file, or pull from a bank.
          They are the same intent and produce the same artifact — an import card in the history below —
          so neither is a subsection of the other.

          The bases are what decide when they stack, and they are set low on purpose: at the original
          sizes an ordinary window put the connections card *below* the importer, which reads as it being
          a lesser thing rather than a peer. Both were trimmed (the drop target's padding most of all —
          it had a screenful of blank space it did not need) so the side-by-side layout survives down to
          a fairly narrow pane, and the row wraps rather than squeezing once it genuinely cannot. */}
      {/* Above the two ways data arrives by hand, because what it reports is work already waiting rather
          than a third thing to start. Renders nothing at all until some source names a folder. */}
      {stage === 'upload' && (
        <WatchedFoldersPanel
          onOpenFile={(file, profileId) => handleFile(file, { sourceIdOverride: profileId })}
          onImported={() => api.listBatches().then(setBatches).catch(() => { })}
        />
      )}

      {stage === 'upload' && (
        <div style={{ display: 'flex', gap: 16, alignItems: 'stretch', flexWrap: 'wrap', marginBottom: 20 }}>
        <div ref={uploadStageRef} style={{ flex: '1 1 340px', minWidth: 0 }}>
          <ImportUploadStage
            demoLoaded={demoLoaded}
            chooserOpen={sourceChooserOpen}
            hasSelectedSource={hasSelectedUploadSource}
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
            setEditingSourceDescriptionId={setEditingSourceDescriptionId}
            setSourceDescriptionDraft={setSourceDescriptionDraft}
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
          onOpenSyncLog={() => setSyncLogOpen(true)}
        />
        </div>
      )}

      {stage === 'mapping' && preview && (
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
                <button
                  type="button"
                  onClick={() => setShowMappingSourceChooser(open => !open)}
                  title="Change data source"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    marginLeft: 2,
                    padding: '1px 7px',
                    borderRadius: 999,
                    border: '1px solid color-mix(in srgb, var(--border) 88%, transparent)',
                    background: selectedProfile ? 'color-mix(in srgb, var(--accent) 8%, var(--surface2))' : 'color-mix(in srgb, var(--surface2) 88%, var(--surface))',
                    color: selectedProfile ? 'var(--accent2)' : 'var(--muted)',
                    fontSize: 10,
                    fontWeight: selectedProfile ? 600 : 500,
                    lineHeight: 1.15,
                    position: 'relative',
                    top: -7,
                    cursor: 'pointer',
                    verticalAlign: 'super',
                  }}>
                  {selectedProfile ? (profiles.find(p => p.id === selectedProfile)?.name || 'Saved data source') : 'temporary draft'}
                </button>
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
                  <button
                    type="button"
                    onClick={returnToUploadSourceChooser}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      margin: 0,
                      fontSize: 12,
                      color: 'var(--muted)',
                      cursor: 'pointer',
                    }}
                  >
                    Start over
                  </button>
                </div>
              </div>
            ) : null}

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 0 }} />
              <button onClick={() => setShowRaw(v => !v)} style={{
                background: showRaw ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))' : 'var(--surface2)',
                border: `1px solid ${showRaw ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 6, padding: '5px 10px', fontSize: 12,
                cursor: 'pointer', color: showRaw ? 'var(--accent2)' : 'var(--muted)',
                whiteSpace: 'nowrap', flexShrink: 0,
              }}>
                {showRaw ? '× Close raw file' : '⌗ View raw file'}
              </button>
              <button onClick={() => setShowAdvanced(v => !v)} style={{
                background: 'none', border: 'none', fontSize: 12, cursor: 'pointer',
                color: showAdvanced ? 'var(--accent2)' : 'var(--muted)',
                padding: '5px 4px', whiteSpace: 'nowrap', flexShrink: 0,
              }}>
                {showAdvanced ? '▴ Advanced' : '▾ Advanced'}
              </button>
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
                    small
                    variant="ghost"
                    onClick={() => setShowRaw(v => !v)}
                    style={showRaw
                      ? {
                        background: 'color-mix(in srgb, var(--accent) 12%, var(--surface2))',
                        border: '1px solid color-mix(in srgb, var(--accent2) 24%, var(--border))',
                        color: 'var(--accent2)',
                      }
                      : undefined}
                  >
                    {showRaw ? 'Hide raw file' : 'Review raw file'}
                  </Button>
                  <Button
                    small
                    variant="ghost"
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
              onChange={setEvidenceColumns}
            />

          </Card>

          {colAccount && distinctAccountValues.length > 0 && (
            <Card style={{ padding: 0, overflow: 'hidden', width: IMPORT_CONFIG_MAX_WIDTH }}>
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 16px 240px 52px',
                padding: '6px 14px', gap: 12,
                fontSize: 11, fontWeight: 600, color: 'var(--muted)',
                borderBottom: '1px solid var(--border)',
                background: 'var(--surface2)',
              }}>
                <span>Account from file</span>
                <span></span>
                <span>Maps To</span>
                <span style={{ textAlign: 'center' }}>Skip</span>
              </div>
              {distinctAccountValues.map(csvVal => {
                const DEFAULT_ENTRY = {
                  accountId: '',
                  createNew: false,
                  newName: csvVal,
                  newType: '',
                  groupWithAccountId: '',
                  skip: false,
                }
                const m = { ...DEFAULT_ENTRY, ...(accountMap[csvVal] || {}) }
                const update = patch => setAccountMap(prev => ({
                  ...prev,
                  [csvVal]: { ...DEFAULT_ENTRY, ...(prev[csvVal] || {}), ...patch }
                }))
                const alreadyImported = previousImportAccountsByValue.get(csvVal)
                const candidates = accountMatchesByValue[csvVal]?.candidates || []
                const likelyMatch = accountMatchesByValue[csvVal]?.likely || null
                const likelyMatchLabel = getAccountMatchLabel(likelyMatch) || likelyMatch?.name || ''
                const relationshipTargetId = m.groupWithAccountId || ''
                const relationshipTarget = relationshipTargetId
                  ? accounts.find(account => account.id === relationshipTargetId)
                  : null
                const relationshipLabel = getAccountMatchLabel(relationshipTarget) || relationshipTarget?.name || ''
                return (
                  <div key={csvVal} style={{
                    display: 'grid', gridTemplateColumns: '1fr 16px 240px 52px',
                    gap: 12, padding: '7px 14px', alignItems: 'center',
                    borderBottom: '1px solid var(--border)',
                    opacity: alreadyImported ? 0.5 : (m.skip ? 0.45 : 1),
                  }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={csvVal}>{csvVal}</div>
                      {alreadyImported ? (
                        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>
                          Already imported · {alreadyImported.row_count} rows
                        </div>
                      ) : null}
                    </div>

                    <span style={{ color: 'var(--muted)', textAlign: 'center', fontSize: 11 }}>→</span>

                    {alreadyImported ? (
                      <span style={{ fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>
                        already imported
                      </span>
                    ) : m.skip ? (
                      <span style={{ fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>
                        skipping {Number(accountValueCounts[csvVal] || 0)} transaction{Number(accountValueCounts[csvVal] || 0) === 1 ? '' : 's'}
                      </span>
                    ) : !m.createNew ? (
                      <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
                          <AccountMatchSelect
                            name={`account-map-target-${csvVal}`}
                            value={m.accountId}
                            // Marketplace accounts (Amazon, …) are filled by their own importer, not
                            // by mapping a CSV onto them, so they are not offered here.
                            options={accounts.filter(a => !isMarketplaceAccountType(a.type))}
                            candidates={candidates}
                            inFlightOptions={inFlightNewAccounts.map(n => ({
                              value: n.name, label: `${n.name} (new)`, type: n.type,
                            }))}
                            // Sharing a new account another label is creating in this import. We don't
                            // reference that label — we independently declare the same name, which the
                            // importer merges by name (so changing the other label later can't dangle
                            // this one).
                            onSelectInFlight={option => update({
                              accountId: '',
                              createNew: true,
                              newName: option.value,
                              newType: option.type || guessNewAccountTypeFromName(csvVal),
                              groupWithAccountId: '',
                            })}
                            // Picking from the list maps to it. That is the whole interaction — the
                            // relationship question belongs to `+New`, which is the path where a
                            // second question genuinely remains.
                            onSelectAccount={a => update({
                              accountId: a.id,
                              createNew: false,
                              groupWithAccountId: '',
                            })}
                            onClear={() => update({
                              accountId: '',
                              createNew: false,
                              newName: csvVal,
                              groupWithAccountId: '',
                            })}
                          />
                          {m.accountId ? (
                            <button
                              onClick={() => update({
                                accountId: '',
                                createNew: false,
                                newName: csvVal,
                                groupWithAccountId: '',
                              })}
                              style={{
                                flexShrink: 0, background: 'none', border: '1px solid var(--border)',
                                borderRadius: 6, color: 'var(--muted)', cursor: 'pointer',
                                fontSize: 13, width: 28, height: 28, lineHeight: 1, padding: 0,
                              }}
                              aria-label="Clear account mapping"
                            >
                              ×
                            </button>
                          ) : (
                            <button
                              // With possible matches, ask before creating: the dialog is where they
                              // are shown, which is what lets "Keep separate" record an assertion about
                              // them. With none there is nothing to show and nothing to assert, so this
                              // stays a one-press create.
                              onClick={() => {
                                if (candidates.length) {
                                  openAccountMatchChooser(csvVal, candidates)
                                  return
                                }
                                update({
                                  createNew: true,
                                  newName: csvVal,
                                  newType: guessNewAccountTypeFromName(csvVal),
                                  groupWithAccountId: '',
                                })
                              }}
                              style={{
                                flexShrink: 0, background: 'none', border: '1px solid var(--border)',
                                borderRadius: 6, color: 'var(--accent2)', cursor: 'pointer',
                                fontSize: 11, padding: '4px 7px', whiteSpace: 'nowrap',
                              }}
                            >+New</button>
                          )}
                        </div>
                        {!m.accountId && likelyMatchLabel ? (
                          <button
                            type="button"
                            onClick={() => update({
                              accountId: likelyMatch.id,
                              createNew: false,
                              newName: likelyMatch.name || csvVal,
                              newType: likelyMatch.type || m.newType || 'depository',
                              groupWithAccountId: '',
                              skip: false,
                            })}
                            style={{
                              justifySelf: 'end',
                              maxWidth: '100%',
                              border: '1px solid color-mix(in srgb, var(--accent2) 28%, var(--border))',
                              background: 'color-mix(in srgb, var(--accent2) 10%, var(--surface2))',
                              color: 'var(--accent2)',
                              borderRadius: 999,
                              padding: '4px 9px',
                              fontSize: 11,
                              cursor: 'pointer',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                            title={`Map to ${likelyMatchLabel}`}
                          >
                            Possible match: {likelyMatchLabel}
                          </button>
                        ) : null}
                      </div>
                    ) : (
                      <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
                        <div style={{ display: 'flex', gap: 4, alignItems: 'center', minWidth: 0, flexWrap: 'nowrap' }}>
                          <div style={{ width: 132, maxWidth: '100%' }}>
                            <input name={`account-new-name-${csvVal}`} value={m.newName} onChange={e => update({ newName: e.target.value })}
                              placeholder="Name" style={{
                                width: '100%', background: 'var(--surface2)', color: 'var(--text)',
                                border: `1px solid ${accounts.some(a => a.name.toLowerCase() === m.newName.trim().toLowerCase()) ? 'var(--danger)' : 'var(--accent)'}`,
                                borderRadius: 6, padding: '4px 6px', fontSize: 12, outline: 'none',
                              }} />
                            {accounts.some(a => a.name.toLowerCase() === m.newName.trim().toLowerCase()) && (
                              <div style={{ fontSize: 10, color: 'var(--danger)', marginTop: 2 }}>
                                Name already exists — select it instead
                              </div>
                            )}
                          </div>
                          <select name={`account-new-type-${csvVal}`} value={m.newType} onChange={e => update({ newType: e.target.value })}
                            style={{ width: 88, background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 5px', fontSize: 11 }}>
                            <option value="">— Type —</option>
                            {GENERIC_IMPORT_ACCOUNT_TYPES.map(option => (
                              <option key={option.value} value={option.value}>{option.shortLabel}</option>
                            ))}
                          </select>
                          <button onClick={() => update({
                            createNew: false,
                            accountId: '',
                            groupWithAccountId: '',
                          })}
                            style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 13, padding: '2px', flexShrink: 0 }}>✕</button>
                        </div>
                        {relationshipTarget && relationshipLabel ? (
                          <button
                            type="button"
                            onClick={() => openAccountMatchChooser(csvVal, [relationshipTarget])}
                            style={{
                              justifySelf: 'start',
                              maxWidth: '100%',
                              border: '1px solid color-mix(in srgb, var(--accent2) 26%, var(--border))',
                              background: 'color-mix(in srgb, var(--accent2) 10%, var(--surface2))',
                              color: 'var(--accent2)',
                              borderRadius: 999,
                              padding: '4px 9px',
                              fontSize: 11,
                              cursor: 'pointer',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                            title={m.groupWithAccountId ? `Change grouping target for ${relationshipLabel}` : `Change duplicate comparison target for ${relationshipLabel}`}
                          >
                            {m.groupWithAccountId ? 'Will group with: ' : 'Checking duplicates against: '}
                            {relationshipLabel}
                          </button>
                        ) : null}
                      </div>
                    )}

                    <div style={{ display: 'flex', justifyContent: 'center' }}>
                      {alreadyImported ? (
                        <span style={{ fontSize: 11, color: 'var(--muted)' }}>—</span>
                      ) : (
                        <input
                          name={`account-skip-${csvVal}`}
                          type="checkbox"
                          checked={!!m.skip}
                          onChange={e => update({ skip: e.target.checked })}
                          style={{ width: 15, height: 15, cursor: 'pointer', accentColor: 'var(--accent)' }}
                        />
                      )}
                    </div>
                  </div>
                )
              })}
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
                    small
                    variant="ghost"
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

          <div style={{ display: 'flex', gap: 10 }}>
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
            <Button variant="ghost" onClick={resetImport}>Cancel</Button>
          </div>
        </div>
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
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
                <Button variant="ghost" onClick={cancelTrailingDataReview} disabled={loading}>
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

      {stage === 'done' && importResult && (
        // Wrapper rather than a ref on Card: Card is a plain function component, so a ref passed to it
        // would be dropped (and warn) instead of reaching the DOM node the scroll needs.
        <div ref={doneStageRef}>
        <Card>
          <div style={{ fontSize: 18, marginBottom: 12 }}>✅ Import complete</div>
          {importResult.has_imported_categories ? (
            <div style={{
              marginBottom: 16,
              padding: '12px 14px',
              borderRadius: 12,
              background: 'color-mix(in srgb, var(--accent) 7%, var(--surface2))',
              border: '1px solid color-mix(in srgb, var(--accent) 24%, var(--border))',
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                Categorized rows were imported with this file.
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
                {useImportedCategories && colCategory
                  ? 'Because categories present in the data were used for this file, missing categories were added under Unassigned, the imported transactions kept those categories, and the file now contributes to system-wide rule suggestions.'
                  : 'This file appears to already carry its own categories. If that data is clean and curated, turn on “categories present in the data” on its card under Recent imports — that keeps those categories on the imported transactions and uses them to suggest rules. If only some accounts or owners are curated, you can scope it to just those.'}
              </div>
            </div>
          ) : null}
          {(() => {
            const summary = summarizeImportOutcome(importResult)
            const parts = []
            if (summary.accountSkippedCount > 0) {
              parts.push(
                <span key="skipped-accounts">{summary.accountSkippedCount} from skipped accounts</span>
              )
            }
            if (summary.rejectedCount > 0) {
              parts.push(
                <button
                  key="rejected-rows"
                  type="button"
                  onClick={() => openRejectedRowsViewer({
                    source: importResult,
                    title: 'this import',
                    allowRawViewer: true,
                  })}
                  style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent2)', textDecoration: 'underline', cursor: 'pointer', fontSize: 'inherit' }}
                >
                  {summary.rejectedCount} rejected row{summary.rejectedCount === 1 ? '' : 's'}
                </button>
              )
            }
            if (summary.zeroAmountCount > 0) {
              parts.push(
                <span key="zero-amount-rows">{summary.zeroAmountCount} zero amount</span>
              )
            }
            if (summary.currencyRejectedCount > 0) {
              parts.push(
                <span key="currency-rows">{summary.currencyRejectedCount} in another currency</span>
              )
            }
            if (summary.validationErrorCount > 0) {
              parts.push(
                <span key="validation-errors">{summary.validationErrorCount} validation error{summary.validationErrorCount === 1 ? '' : 's'}</span>
              )
            }
            if (summary.trailingNonTransactionCount > 0) {
              parts.push(
                <span key="non-transaction-rows">{summary.trailingNonTransactionCount} non-transaction rows</span>
              )
            }
            if (summary.otherSkippedCount > 0) {
              parts.push(
                <span key="other-skipped">{summary.otherSkippedCount} other skipped</span>
              )
            }

            // Lead with what actually happened. A file whose rows all duplicate existing history is a
            // *successful* import for an enrich-oriented source (a PayPal export duplicates what the bank
            // already shows; the value delivered is the detail folded into those matches) — so it says so
            // rather than reporting "0 transactions imported", which reads as a failure. The row counts
            // then appear once each, in their own lines, instead of a combined breakdown whose
            // "0 imported, 0 not imported, 59 deduped" arithmetic contradicted itself.
            const everyRowDuplicate = summary.importedCount === 0
              && summary.dedupedCount > 0
              && summary.dedupedCount === summary.totalRows
            const headline = summary.importedCount > 0
              ? `${summary.importedCount} transaction${summary.importedCount === 1 ? '' : 's'} imported.`
              : everyRowDuplicate
                ? 'No new transactions — every row was already in the ledger.'
                : 'No new transactions imported.'

            return (
              <div style={{
                marginBottom: 16,
                padding: '10px 14px',
                borderRadius: 12,
                border: '1px solid color-mix(in srgb, var(--border) 88%, white 4%)',
                background: 'color-mix(in srgb, var(--surface2) 26%, transparent)',
              }}>
                <div style={{ fontSize: 14, color: 'var(--text)', fontWeight: 600, marginBottom: 4 }}>
                  {headline}
                </div>
                {summary.totalRows > 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>
                    {summary.totalRows} row{summary.totalRows === 1 ? '' : 's'} in this file.
                  </div>
                ) : null}
                {summary.dedupedCount > 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>
                    <button
                      type="button"
                      onClick={() => openDuplicateRowsViewer({
                        source: importResult,
                        title: 'this import',
                      })}
                      style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent2)', textDecoration: 'underline', cursor: 'pointer', fontSize: 'inherit' }}
                    >
                      {summary.dedupedCount} duplicate row{summary.dedupedCount === 1 ? '' : 's'}
                    </button>
                    {' '}matched existing transactions.
                  </div>
                ) : null}
                {summary.enrichedCount > 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>
                    New detail added from {summary.enrichedCount} duplicate row{summary.enrichedCount === 1 ? '' : 's'}.
                  </div>
                ) : null}
                {summary.skippedCount > 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>
                    {summary.skippedCount} row{summary.skippedCount === 1 ? '' : 's'} couldn&rsquo;t be imported
                    {parts.length > 0 ? (
                      <>
                        {' ('}
                        {parts.map((part, index) => (
                          <span key={index}>
                            {index > 0 ? ', ' : ''}
                            {part}
                          </span>
                        ))}
                        {')'}
                      </>
                    ) : null}
                    .
                  </div>
                ) : null}
              </div>
            )
          })()}
          {!importResult.has_imported_categories && !hasAnyLeafCategory && !starterPromptDismissed ? (
            <div style={{
              marginBottom: 16,
              padding: '12px 14px',
              borderRadius: 12,
              background: 'color-mix(in srgb, var(--accent2) 7%, var(--surface2))',
              border: '1px solid color-mix(in srgb, var(--accent2) 24%, var(--border))',
            }}>
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
                  small
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
                <Button small variant="ghost" onClick={() => setShowStarterRules(true)}>
                  Add starter rules…
                </Button>
                <Button small variant="ghost" onClick={() => setStarterPromptDismissed(true)}>
                  Not now
                </Button>
              </div>
            </div>
          ) : null}
          {importResult.new_accounts_without_owner > 0 && (
            <div style={{
              fontSize: 13, marginBottom: 16, padding: '8px 12px',
              background: 'color-mix(in srgb, var(--accent2) 8%, var(--surface2))',
              border: '1px solid color-mix(in srgb, var(--accent2) 30%, var(--border))',
              borderRadius: 8,
            }}>
              {importResult.new_accounts_without_owner} new account{importResult.new_accounts_without_owner > 1 ? 's were' : ' was'} created without an owner.
              {' '}These accounts have no owner assigned — visit{' '}
              <Link to="/accounts" style={{ color: 'var(--accent2)', textDecoration: 'none' }}>
                Accounts
              </Link>
              {' '}to assign one.
            </div>
          )}
          {importResult.errors?.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: 'var(--danger)' }}>{importResult.errors.length} validation error{importResult.errors.length === 1 ? '' : 's'}:</div>
              {importResult.errors.map((e, i) => <div key={i} style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 3 }}>Row {e.row}: {e.reason}</div>)}
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {importResult?.batch_id ? (
              <Button
                variant="ghost"
                onClick={() => openUndo(getUndoTargetForSource(importResult))}
              >
                Undo import
              </Button>
            ) : null}
            <Button onClick={importAnotherFile}>Import another file</Button>
          </div>
        </Card>
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

      {stage !== 'mapping' && (
        <ImportHistorySection
          dataSourceRows={dataSourceRows}
          profiles={profiles}
          onReviewMoneyMovement={reviewMoneyMovementForProfile}
          expandedSourceRows={expandedSourceRows}
          setExpandedSourceRows={setExpandedSourceRows}
          setShowDataSourceManager={setShowDataSourceManager}
          openSystemCategoryWorkspace={openSystemCategoryWorkspace}
          totalSystemCategoryWorkspaceCount={totalSystemCategoryWorkspaceCount}
          pendingSystemCategoryCount={pendingSystemCategoryCount}
          openRuleSuggestionReview={openRuleSuggestionReview}
          hasSystemRuleSuggestionWork={hasSystemRuleSuggestionWork}
          pendingSystemRuleSuggestionCount={pendingSystemRuleSuggestionCount}
          editingSourceNameKey={editingSourceNameKey}
          setEditingSourceNameKey={setEditingSourceNameKey}
          getSourceNameEditKey={getSourceNameEditKey}
          sourceNameDraft={sourceNameDraft}
          setSourceNameDraft={setSourceNameDraft}
          saveSourceName={saveSourceName}
          editingSourceDescriptionId={editingSourceDescriptionId}
          setEditingSourceDescriptionId={setEditingSourceDescriptionId}
          sourceDescriptionDraft={sourceDescriptionDraft}
          setSourceDescriptionDraft={setSourceDescriptionDraft}
          saveSourceDescription={saveSourceDescription}
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
          openDetailStorage={() => setShowDetailStorage(true)}
        />
      )}

      {/* Under the history rather than beside it, because it explains the rows above: a synced card that
          landed less than expected is read here. It sits on this tab at all because a sync's own record
          belongs where the sync's output is, not in Settings — see `docs/ui-patterns.md`. Scoped by the
          `?connection=` a connection card links with, so arriving from one lands filtered to it. */}
      {syncLogOpen ? (
        <ConnectionSyncLogDialog
          initialConnectionIds={syncLogConnectionId ? [syncLogConnectionId] : []}
          onClose={() => setSyncLogOpen(false)}
        />
      ) : null}

      {showDetailStorage ? (
        <ImportDetailStorageDialog
          dataSourceRows={dataSourceRows}
          onClose={() => setShowDetailStorage(false)}
          onCleared={() => api.listBatches().then(setBatches).catch(() => { })}
        />
      ) : null}

      {showDataSourceManager ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 320,
            background: 'rgba(15, 23, 42, 0.42)',
          }}
        >
          {(() => {
            const managerPanelStyle = getFloatingPanelSurfaceStyle({
              active: !dataSourceManagerEditing,
              radius: 16,
            })
            return (
              <div
                ref={dataSourceManagerRef}
                onClick={event => event.stopPropagation()}
                style={{
                  width: 'min(1040px, calc(100vw - 96px))',
                  minHeight: 380,
                  maxHeight: '78vh',
                  position: 'fixed',
                  left: (dataSourceManagerPos || getDataSourceManagerDefaultPosition()).x,
                  top: (dataSourceManagerPos || getDataSourceManagerDefaultPosition()).y,
                  overflow: 'hidden',
                  display: 'grid',
                  gridTemplateRows: 'auto minmax(0, 1fr)',
                  userSelect: dataSourceManagerDragging ? 'none' : 'auto',
                  ...managerPanelStyle,
                }}
              >
                <div
                  onMouseDown={startDataSourceManagerDrag}
                  style={{
                    padding: '16px 20px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    borderBottom: '1px solid var(--border)',
                    background: getFloatingPanelHeaderBackground(!dataSourceManagerEditing),
                    cursor: dataSourceManagerEditing ? 'default' : (dataSourceManagerDragging ? 'grabbing' : 'grab'),
                  }}
                >
                  <div>
                    <div style={{ fontSize: 17, fontWeight: 600 }}>Manage data sources</div>
                    <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
                      Edit saved CSV data sources without leaving Import / Export.
                      {!dataSourceManagerEditing ? ' Drag to move.' : ''}
                    </div>
                  </div>
                  {!dataSourceManagerEditing ? (
                    <Button
                      variant="ghost"
                      onMouseDown={event => event.stopPropagation()}
                      onClick={closeDataSourceManager}
                    >
                      Close
                    </Button>
                  ) : <div style={{ width: 74 }} />}
                </div>
                <div style={{ overflow: 'auto', background: 'color-mix(in srgb, var(--surface2) 30%, var(--surface))' }}>
                  <ImportProfilesManager
                    embedded
                    onEditingChange={setDataSourceManagerEditing}
                    onDataChange={handleManagerDataChange}
                    initialMode={dataSourceManagerInitialMode}
                    onProfileCreated={handleManagerProfileCreated}
                  />
                </div>
              </div>
            )
          })()}
        </div>
      ) : null}

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

      {pendingAccountMatchChooser ? (
        <PossibleAccountMatchChooserDialog
          pending={pendingAccountMatchChooser}
          onSelect={applyAccountMatchChoice}
          onCancel={() => setPendingAccountMatchChooser(null)}
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
    </div>
  )
}

// Amazon order import: upload one or both AZAD exports (orders + items), pick or create the account the
// items land in, and run the parse→apply pipeline. Files are sniffed server-side, so either file alone is
// accepted; the result panel reports the per-disposition + orphan counts the backend returns. The account
// control follows the "creating is available wherever assigning is" rule (inline create). The drop zone is
// a small local control, not the CSV `ImportUploadStage`, which is coupled to the data-source /
// header-fingerprint flow this import does not use.
// Sentinel Select value for the explicit "untracked" state (a card that isn't one of the user's
// accounts). Distinct from '' (not yet decided) and from any real account id.
const FUNDING_UNTRACKED = '__untracked__'

function formatInstrumentLabel(last4, network) {
  const net = (network || '').trim()
  return net ? `${net} ···${last4}` : `···${last4}`
}

// Sentinel Select value: "create a new funding account for this card".
const FUNDING_NEW = '__new_funding_account__'

const mapLabelStyle = { fontSize: 13, color: 'var(--text)', fontWeight: 600, marginTop: 22, marginBottom: 8 }

// One "Account from file" row for a payment card the scan found in the files: the card label → the
// account it charges (an existing account, Untracked, or + New). Mirrors the CSV importer's
// account-mapping rows; the chosen mapping persists to the global funding map (prefilling next time).
function AmazonPaymentSourceRow({ instrument, accountOptions, disabled, onPick, onCreateAccount }) {
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const value = instrument.state === 'untracked' ? FUNDING_UNTRACKED
    : instrument.state === 'mapped' ? (instrument.funding_account_id || '')
    : ''
  const submitNew = async () => {
    const name = newName.trim()
    if (!name) return
    await onCreateAccount(instrument, name)
    setCreating(false); setNewName('')
  }
  return (
    <div style={{ padding: '9px 0', borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: '0 0 auto', minWidth: 150, fontSize: 13, color: 'var(--text)' }}>
          {formatInstrumentLabel(instrument.last4, instrument.network)}
        </div>
        {instrument.state === 'unmapped' ? <Badge label="Needs mapping" toneKey="pending" /> : null}
        <div style={{ flex: 1, minWidth: 0 }}>
          <Select
            value={creating ? FUNDING_NEW : value}
            onChange={v => { if (v === FUNDING_NEW) { setCreating(true) } else { setCreating(false); onPick(instrument, v) } }}
            options={accountOptions}
            aria-label={`Account for ${formatInstrumentLabel(instrument.last4, instrument.network)}`}
            disabled={disabled}
          />
        </div>
      </div>
      {creating && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8, marginLeft: 160 }}>
          <Input value={newName} onChange={setNewName} placeholder="New account name"
            aria-label="New account name" style={{ flex: 1 }} />
          <Button small onClick={submitNew} disabled={disabled || !newName.trim()}>Create</Button>
          <Button small variant="ghost" onClick={() => { setCreating(false); setNewName('') }}>Cancel</Button>
        </div>
      )}
    </div>
  )
}

// The Amazon import mapping screen. Mirrors the CSV import-mapping page: the dropped files up top, then
// the target account + the excluded category for the matched card charge, then a row per payment card
// found in the files (mapped to the account it charges), an "apply my rules" toggle, and Import / Cancel.
// The card mappings + category are global and prefill on the next import; Import is gated until the
// account is chosen and every discovered card has a decision.
function AmazonImportTab({ initialFiles }) {
  const NEW_ACCOUNT = '__new__'
  // The backend refuses the import while demo data is loaded, so the tab says so up front rather than after
  // the form is filled in.
  const { demoLoaded } = useAppSession()
  const [accounts, setAccounts] = useState([])
  // Persisted per user so the chosen Amazon account carries over from visit to visit.
  const [accountId, setAccountId] = useUserPreference(AMAZON_IMPORT_ACCOUNT_PREF_KEY, '')
  const [creatingAccount, setCreatingAccount] = useState(false)
  const [newAccountName, setNewAccountName] = useState('Amazon')
  const [savingAccount, setSavingAccount] = useState(false)
  const [files, setFiles] = useState([])
  const [scan, setScan] = useState(null)            // { instruments, unrecognized_files, ... } | null
  const [skippedFilesAlert, setSkippedFilesAlert] = useState(null)   // already-imported names awaiting an OK
  const [scanning, setScanning] = useState(false)
  const [categories, setCategories] = useState([])
  const [fundingCategory, setFundingCategory] = useState(null)
  const [applyCategorization, setApplyCategorization] = useState(true)
  const [busy, setBusy] = useState(false)           // a mapping/category save in flight
  const [loading, setLoading] = useState(false)     // the import itself
  const [summary, setSummary] = useState(null)
  const [error, setError] = useState('')
  const [amazonBatches, setAmazonBatches] = useState([])   // this tab's recent Amazon imports
  const [historyExpanded, setHistoryExpanded] = useState(true)
  const fileInputRef = useRef(null)
  const reconciliationViewer = useReconciliationViewer()

  const loadAccounts = useCallback(
    () => api.getAccounts({ include_children: true }).then(setAccounts).catch(() => {}),
    [],
  )
  const loadBatches = useCallback(
    () => api.listBatches()
      .then(rows => setAmazonBatches((rows || []).filter(b => b.source_kind === 'marketplace:amazon')))
      .catch(() => {}),
    [],
  )
  useEffect(() => {
    loadAccounts()
    loadBatches()
    api.getCategories().then(setCategories).catch(() => {})
    api.getAmazonFundingCategory().then(setFundingCategory).catch(() => {})
  }, [loadAccounts, loadBatches])
  useEffect(() => { if (initialFiles?.length) setFiles(initialFiles) }, [initialFiles])

  // Drop a remembered account that no longer exists (deleted, or no longer an Amazon account) once the
  // account list has loaded, so the selector doesn't sit on a stale value.
  useEffect(() => {
    if (!accountId || !accounts.length) return
    if (!accounts.some(a => a.id === accountId && (a.type || '').toLowerCase() === 'amazon')) setAccountId('')
  }, [accounts, accountId, setAccountId])

  // Resolving items in the floating reconciliation report changes a batch's "N to resolve" count, which the
  // backend recomputes in listBatches — so refetch this tab's Amazon batches when the report loads.
  const reconVersion = reconciliationViewer.viewer?.data?.version || 0
  useEffect(() => {
    if (reconVersion === 0) return
    loadBatches()
  }, [reconVersion, loadBatches])

  // Shared undo + file-ledger flows, same as the main import tab (see useBatchUndo / useBatchDetailPanels).
  const { openUndo, undoNode } = useBatchUndo(async () => { await loadBatches() })
  const { openBatchDetail, panelsNode } = useBatchDetailPanels({
    categories,
    onAddCategory: category => setCategories(prev => prev.some(existing => existing.id === category.id) ? prev : [...prev, category]),
    onReviewCountChange: (batchId, count) => setAmazonBatches(prev => prev.map(batch => (
      batch.id === batchId && batch.needs_review_count !== count ? { ...batch, needs_review_count: count } : batch
    ))),
  })
  const markReviewed = async (batchId) => { await api.markBatchReviewed(batchId); await loadBatches() }

  // Scan the dropped files for their payment cards whenever the files (or the target account, which
  // affects per-account override resolution) change. Read-only — no ledger changes.
  // Already-imported files (matched by content) get a must-acknowledge notice whose OK drops them from
  // the selection — so a later rescan can't see (or re-nag about) them.
  const rescan = useCallback((currentFiles, currentAccountId) => {
    if (!currentFiles.length) { setScan(null); return Promise.resolve() }
    setScanning(true)
    return api.scanAmazonFiles(currentFiles, currentAccountId)
      .then(result => {
        setScan(result)
        const skipped = result?.already_imported_files || []
        if (skipped.length) setSkippedFilesAlert(skipped)
      })
      .catch(e => { setError(e?.message || 'Could not read the files'); setScan(null) })
      .finally(() => setScanning(false))
  }, [])
  useEffect(() => { rescan(files, accountId) }, [files, accountId, rescan])

  const onAccountChange = (value) => {
    if (value === NEW_ACCOUNT) { setCreatingAccount(true); setAccountId('') }
    else { setCreatingAccount(false); setAccountId(value) }
  }
  const createAccount = async () => {
    const name = newAccountName.trim()
    if (!name) return
    setSavingAccount(true); setError('')
    try {
      const created = await api.createAccount({ name, type: 'amazon' })
      await loadAccounts()
      setAccountId(created.id)
      setCreatingAccount(false)
    } catch (e) {
      setError(e?.message || 'Could not create account')
    } finally {
      setSavingAccount(false)
    }
  }

  const addFiles = (list) => {
    // Snapshot the FileList to a real array *now*, synchronously — the <input>'s live FileList empties
    // the moment we reset `e.target.value = ''`, and the setFiles updater runs later.
    const incoming = Array.from(list)
    setFiles(prev => {
      const byName = new Map(prev.map(f => [f.name, f]))
      for (const f of incoming) byName.set(f.name, f)
      return Array.from(byName.values())
    })
  }
  const clearAll = () => {
    setFiles([]); setScan(null); setSummary(null); setError('')
  }

  // Map / untrack a payment card → persist to the global funding map, then re-scan to reflect.
  const pickPaymentSource = async (instrument, value) => {
    if (!value) return
    setBusy(true)
    try {
      const body = { last4: instrument.last4, network: instrument.network || null }
      if (value === FUNDING_UNTRACKED) body.untracked = true
      else body.funding_account_id = value
      await api.saveAmazonFundingSource(body)
      await rescan(files, accountId)
    } finally { setBusy(false) }
  }
  const createFundingAccount = async (instrument, name) => {
    setBusy(true)
    try {
      const created = await api.createAccount({ name, type: 'credit' })
      await loadAccounts()
      await api.saveAmazonFundingSource({ last4: instrument.last4, network: instrument.network || null, funding_account_id: created.id })
      await rescan(files, accountId)
    } finally { setBusy(false) }
  }

  const chooseCategory = async (categoryId) => {
    if (!categoryId) return
    setBusy(true)
    try { setFundingCategory(await api.setAmazonFundingCategory(categoryId)) } finally { setBusy(false) }
  }

  const run = async () => {
    setError(''); setSummary(null); setLoading(true)
    try {
      setSummary(await api.importAmazon(files, accountId, applyCategorization))
      clearAll()
      loadBatches()
    } catch (e) {
      setError(e?.message || 'Import failed')
    } finally {
      setLoading(false)
    }
  }

  // The account picker lists Amazon-type accounts only; the funding picker lists the user's non-marketplace
  // accounts (a card charge never lands on an Amazon account), plus Untracked and + New.
  const amazonAccounts = accounts.filter(a => (a.type || '').toLowerCase() === 'amazon')
  const amazonAccountOptions = [
    { value: '', label: amazonAccounts.length ? 'Select an account…' : 'No Amazon account yet — create one →' },
    ...amazonAccounts.map(a => ({ value: a.id, label: a.display_name || a.name })),
    { value: NEW_ACCOUNT, label: '＋ New Amazon account…' },
  ]
  const fundingAccountOptions = [
    { value: '', label: '— Select —' },
    ...accounts.filter(a => !isMarketplaceAccountType(a.type)).map(a => ({ value: a.id, label: a.display_name || a.name })),
    { value: FUNDING_UNTRACKED, label: 'Untracked — not my account' },
    { value: FUNDING_NEW, label: '＋ New account…' },
  ]

  const instruments = scan?.instruments || []
  const unresolved = instruments.filter(i => i.state === 'unmapped')
  const canImport = accountId && files.length > 0 && unresolved.length === 0 && !loading && !busy && !demoLoaded
  const importHint = demoLoaded ? DEMO_IMPORT_DISABLED_MESSAGE
    : loading || canImport || files.length === 0 ? ''
    : !accountId ? 'Choose an account to import into'
    : unresolved.length ? `Map the card ${formatInstrumentLabel(unresolved[0].last4, unresolved[0].network)} (or mark it untracked)`
    : ''
  const c = summary?.counts || {}
  // A drop is split into one card per source file (an orders file + its items folds into one card; an items
  // file with no orders file becomes its own card of discards). The completion screen totals the drop, then
  // lists each card so the user can open its own reconciliation report.
  const importedBatches = summary?.batches || []
  // This tab's recent Amazon imports, shown below the file chooser (where the user lands after an import),
  // rendered through the shared marketplace history section. Cards are ordered by the *data* they cover
  // (newest transaction first), so a multi-year historical drop reads the way it would have if each file
  // had been imported as its purchases happened — not by import time (which ties for one drop). `latestBatch`
  // stays the most-recently-*imported* one (the source list is imported_at-DESC) so "Last used" is unaffected.
  const amazonBatchesByRecency = useMemo(() => [...amazonBatches].sort(byCoverage), [amazonBatches])
  const amazonHistoryRow = { key: 'marketplace:amazon', vendor: 'amazon', label: 'Amazon', batches: amazonBatchesByRecency, latestBatch: amazonBatches[0] || null }

  return (
    <div style={{ maxWidth: 640 }}>
      <Card>
        {/* The launcher follows the card's state, because the two states pose different questions: an
            empty card is asking how to produce an AZAD export, a filled one how to fill in the form. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <FeatureExplainer
            topic={files.length === 0 ? 'amazon-import' : 'amazon-funding-sources'}
            placement="bottom-left"
          />
          <span style={{ fontWeight: 600, color: 'var(--text)' }}>Import Amazon orders</span>
        </div>

        {files.length === 0 ? (
          <>
            <p style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.6, margin: '0 0 12px' }}>
              Import an Amazon order history exported by the <strong>AZAD</strong> Chrome browser extension. Drop the
              <strong> orders</strong> file (the <strong>items</strong> file is optional extra detail) — each is
              recognized by its columns, so upload order does not matter.
            </p>
            {/* The shared target (components/DropZone.jsx), extracted when attaching documents became
                the third surface wanting one. The CSV upload stage keeps its own: its zone is a
                container for the data-source chooser rendered inside it, which this does not model. */}
            <DropZone onFiles={addFiles} accept=".csv" multiple disabled={demoLoaded}>
              {demoLoaded ? DEMO_IMPORT_DISABLED_MESSAGE : 'Drop the AZAD CSV file(s) here, or click to browse.'}
            </DropZone>
          </>
        ) : (
          <>
            {/* 1 — files */}
            <div style={{ ...mapLabelStyle, marginTop: 4 }}>File(s) to import</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {files.map(f => (
                <div key={f.name} style={{ fontSize: 13, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <Button small variant="ghost" onClick={() => fileInputRef.current?.click()} disabled={demoLoaded}>Add file(s)</Button>
              <Button small variant="ghost" onClick={clearAll}>Clear</Button>
            </div>
            {scan?.unrecognized_files?.length ? (
              <div style={{ marginTop: 8, color: '#b45309', fontSize: 12 }}>
                Ignored (not an Amazon export): {scan.unrecognized_files.join(', ')}
              </div>
            ) : null}

            {/* 2 — target account + category */}
            <div style={mapLabelStyle}>Import into account</div>
            <Select value={creatingAccount ? NEW_ACCOUNT : accountId} onChange={onAccountChange} options={amazonAccountOptions} />
            {creatingAccount && (
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <Input value={newAccountName} onChange={setNewAccountName} placeholder="Account name"
                  aria-label="New account name" style={{ flex: 1 }} />
                <Button small onClick={createAccount} disabled={savingAccount || !newAccountName.trim()}>
                  {savingAccount ? 'Creating…' : 'Create'}
                </Button>
                <Button small variant="ghost" onClick={() => { setCreatingAccount(false); setNewAccountName('Amazon') }}>
                  Cancel
                </Button>
              </div>
            )}

            <div style={mapLabelStyle}>Category for matched card charges</div>
            <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.5, margin: '0 0 6px' }}>
              The matching <strong>AMAZON.COM</strong> charge is moved into this (excluded) category so Amazon
              spend counts once. Changes apply to future imports too.
            </p>
            <CategoryPicker
              value={fundingCategory?.category_id}
              categories={categories}
              showSelectedBadge
              onChange={chooseCategory}
              onCategoryCreated={async () => { setCategories(await api.getCategories().catch(() => categories)) }}
            />
            {fundingCategory && !fundingCategory.is_excluded ? (
              <div style={{ color: '#b45309', fontSize: 12, marginTop: 6 }}>
                This category isn’t excluded from totals — Amazon spend may be counted twice. Pick an excluded
                (e.g. Transfers) category.
              </div>
            ) : null}

            {/* 3 — payment sources */}
            <div style={mapLabelStyle}>Payment cards in these files</div>
            {scanning && instruments.length === 0 ? (
              <Spinner />
            ) : instruments.length === 0 ? (
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>No card charges found in these files.</div>
            ) : (
              <div>
                {instruments.map(inst => (
                  <AmazonPaymentSourceRow
                    key={`${inst.last4}|${inst.network || ''}`}
                    instrument={inst}
                    accountOptions={fundingAccountOptions}
                    disabled={busy || loading}
                    onPick={pickPaymentSource}
                    onCreateAccount={createFundingAccount}
                  />
                ))}
              </div>
            )}

            {/* 4 — apply rules */}
            <div style={{ marginTop: 20 }}>
              <Toggle
                checked={applyCategorization}
                onChange={setApplyCategorization}
                label="Apply my categorization rules to the imported orders"
              />
            </div>

            {/* 5 — import / cancel */}
            <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
              <Button onClick={run} disabled={!canImport} title={importHint}>
                {loading ? <>&nbsp;<Spinner />&nbsp;Importing…</> : `Import ${files.length} file${files.length === 1 ? '' : 's'}`}
              </Button>
              <Button variant="ghost" onClick={clearAll} disabled={loading}>Cancel</Button>
            </div>
          </>
        )}

        <input ref={fileInputRef} type="file" accept=".csv" multiple hidden
          onChange={e => { addFiles(e.target.files || []); e.target.value = '' }} />
      </Card>

      {error && (
        <Card style={{ marginTop: 16, border: '1px solid var(--danger)', color: 'var(--danger)', fontSize: 13 }}>
          {error}
        </Card>
      )}

      {summary && (
        <Card style={{ marginTop: 16, fontSize: 13, lineHeight: 1.7 }}>
          <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--text)' }}>
            {importedBatches.length
              ? `Imported ${summary.order_count} order${summary.order_count === 1 ? '' : 's'}${importedBatches.length > 1 ? ` across ${importedBatches.length} files` : ''}.`
              : 'Nothing new to import.'}
          </div>
          <div style={{ color: 'var(--muted)' }}>
            {c.orders_imported ? <div>{c.orders_imported} order{c.orders_imported === 1 ? '' : 's'} imported</div> : null}
            {c.charges_matched ? <div>{c.charges_matched} card charge{c.charges_matched === 1 ? '' : 's'} matched and excluded from totals</div> : null}
            {c.items_enriched ? <div>{c.items_enriched} order{c.items_enriched === 1 ? '' : 's'} enriched with item detail</div> : null}
            {c.items_attached_from_parked ? <div>{c.items_attached_from_parked} order{c.items_attached_from_parked === 1 ? '' : 's'} matched to item detail from an earlier items import</div> : null}
            {c.already_enriched ? <div>{c.already_enriched} item row{c.already_enriched === 1 ? '' : 's'} already enriched (skipped)</div> : null}
            {c.non_cash ? <div>{c.non_cash} non-cash (points / gift-card) — recorded, not counted</div> : null}
            {c.already_applied ? <div>{c.already_applied} already imported (skipped)</div> : null}
          </div>
          {summary.already_imported_files?.length ? (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
              <strong style={{ color: 'var(--text)' }}>
                {summary.already_imported_files.length} file{summary.already_imported_files.length === 1 ? '' : 's'} skipped — already imported
              </strong>
              <div style={{ color: 'var(--muted)' }}>
                {summary.already_imported_files.join(', ')} — identical content was imported before, so it was
                not re-processed. Its existing file card still covers it.
              </div>
            </div>
          ) : null}
          {c.items_discarded ? (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
              <strong style={{ color: 'var(--text)' }}>{c.items_discarded} order{c.items_discarded === 1 ? '' : 's'} of item detail had no matching order</strong>
              <div style={{ color: 'var(--muted)' }}>
                These came from an items file whose orders file hasn’t been imported, so there was nothing to
                attach them to. The detail is saved; importing the matching orders file attaches it automatically.
              </div>
            </div>
          ) : null}
          {importedBatches.length > 1 ? (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
              <div style={{ color: 'var(--muted)', marginBottom: 6 }}>
                Split into {importedBatches.length} files — each is its own card you can review and undo separately:
              </div>
              {importedBatches.map(b => {
                const orphan = Number(b.counts?.items_discarded || 0) > 0
                  && Number(b.counts?.orders_imported || 0) === 0 && Number(b.counts?.non_cash || 0) === 0
                return (
                  <div key={b.batch_id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 2 }}>
                    <button
                      onClick={() => reconciliationViewer.open({ vendor: 'amazon', batchId: b.batch_id, title: b.filename })}
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent2)', fontSize: 13, textAlign: 'left' }}
                    >
                      {b.filename} →
                    </button>
                    <span style={{ color: orphan ? 'var(--warning)' : 'var(--muted)', fontSize: 12 }}>
                      {orphan
                        ? 'items file — its orders file isn’t here yet; detail is saved and attaches automatically when you import it'
                        : `${b.counts?.orders_imported || 0} order${(b.counts?.orders_imported || 0) === 1 ? '' : 's'}`}
                    </span>
                  </div>
                )
              })}
            </div>
          ) : null}
          <div style={{ marginTop: 12, display: 'flex', gap: 16 }}>
            {importedBatches.length === 1 ? (
              <button
                onClick={() => reconciliationViewer.open({ vendor: 'amazon', batchId: importedBatches[0].batch_id, title: importedBatches[0].filename })}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent2)', fontSize: 13 }}
              >
                View reconciliation report →
              </button>
            ) : null}
            <Link to="/accounts" style={{ color: 'var(--accent2)', textDecoration: 'none', fontSize: 13 }}>View your accounts →</Link>
          </div>
        </Card>
      )}

      {/* Recent Amazon imports — shown on the file-chooser (empty) state, so the user sees the file(s)
          they just loaded, with the same file ledger / undo / reconciliation as the main import page. */}
      {files.length === 0 && amazonBatches.length > 0 ? (
        <Card style={{ marginTop: 16, padding: 0, overflow: 'hidden' }}>
          <MarketplaceImportHistory
            row={amazonHistoryRow}
            expanded={historyExpanded}
            onToggleExpand={() => setHistoryExpanded(e => !e)}
            onOpenLedger={openBatchDetail}
            onUndo={openUndo}
            onMarkReviewed={markReviewed}
          />
        </Card>
      ) : null}

      {skippedFilesAlert ? (
        <AppNoticeDialog
          title={`${skippedFilesAlert.length} file${skippedFilesAlert.length === 1 ? ' was' : 's were'} already imported`}
          description="Identical content was imported before (matched by file content, not name), so these will be removed from the selection — their existing file cards still cover them."
          onClose={() => {
            // Acknowledging drops the flagged files (scan reports names; the list is keyed by name), so
            // nothing already imported lingers in the import list.
            const dropped = new Set(skippedFilesAlert)
            setFiles(prev => prev.filter(f => !dropped.has(f.name)))
            setSkippedFilesAlert(null)
          }}
          width="min(560px, 100%)"
        >
          <div style={{ maxHeight: '40vh', overflow: 'auto', fontSize: 13, color: 'var(--text)' }}>
            {skippedFilesAlert.map(name => <div key={name} style={{ padding: '2px 0' }}>{name}</div>)}
          </div>
        </AppNoticeDialog>
      ) : null}
      {undoNode}
      {panelsNode}
    </div>
  )
}

export default function ImportExport() {
  // `?connection=<id>` is how a connection card links to this page's sync log. Read once, because it is a
  // starting position rather than live state: the user is free to change tabs or clear the log's filter
  // afterwards, and re-applying the parameter on every render would keep dragging them back to it.
  const [searchParams] = useSearchParams()
  const [syncLogConnectionId] = useState(() => searchParams.get('connection') || '')
  // Import is the default tab and the sync log lives on it, so a deep link needs nothing further here.
  // If the tab ever stops defaulting to import, a `?connection=` arrival has to force it.
  const [tab, setTab] = useState('import')
  // A file dropped on the general importer that sniffs as an AZAD Amazon export is handed up here and
  // routed to the Amazon tab, which preloads it (see ImportTab.handleFile → onAmazonDetected).
  const [amazonHandoffFiles, setAmazonHandoffFiles] = useState(null)
  const routeToAmazon = useCallback((files) => { setAmazonHandoffFiles(files); setTab('amazon') }, [])
  return (
    <div data-browser-context-passthrough="true" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '32px 32px 0', flexShrink: 0 }}>
        <PageHeader title="Import / Export" help={<FeatureExplainer topic="page-import-export" placement="bottom-left" />} />
      </div>
      <div data-browser-context-passthrough="true" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 32px 32px' }}>
        <div style={{ display: 'flex', marginBottom: 24, borderBottom: '1px solid var(--border)' }}>
          {[['import', 'Import'], ['export', 'Export'], ['backup', 'Backup / Restore'], ['amazon', 'Amazon']].map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} style={{ padding: '8px 24px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 14, color: tab === id ? 'var(--text)' : 'var(--muted)', borderBottom: tab === id ? '2px solid var(--accent)' : '2px solid transparent', fontWeight: tab === id ? 500 : 400 }}>{label}</button>
          ))}
        </div>
        {tab === 'import' && <ImportErrorBoundary><ImportTab onAmazonDetected={routeToAmazon} syncLogConnectionId={syncLogConnectionId} /></ImportErrorBoundary>}
        {tab === 'amazon' && <ImportErrorBoundary><AmazonImportTab initialFiles={amazonHandoffFiles} /></ImportErrorBoundary>}
        {tab === 'export' && <ExportTab />}
        {tab === 'backup' && <BackupRestoreTab />}
      </div>
    </div>
  )
}
