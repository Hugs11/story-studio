import { Suspense, lazy, useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useProjectStore } from './store/projectStore';
import {
  getRecentProjects,
  rememberRecentProject,
  ensureWorkspaceDir,
  pickWorkspaceDir,
  consolidateProject,
} from './store/projectIO';
import { getLastExportDir } from './hooks/useFileDialog';
import { ProjectContext } from './store/ProjectContext';
import { ProjectActionsContext } from './store/ProjectActionsContext';
import { MediaTransferProvider } from './store/MediaTransferContext';
import { collectMediaLibrary } from './store/mediaLibrary';
import { buildProjectIndex } from './store/projectModel';
import { isProjectDirty } from './store/projectHelpers';
import { KEYS, read as readSetting } from './store/persistentSettings';
import { isTtsAvailable, loadXttsSettings, saveXttsSettings } from './store/xttsSettings';
import { useSdStore } from './store/sdStore';
import { useXttsStore } from './store/xttsStore';
import { useRenderQueueStore } from './store/renderQueueStore';
import { useRenderQueueExecutor } from './hooks/useRenderQueueExecutor';
import { useProjectFileAudit } from './hooks/useProjectFileAudit';
import { useProjectDerivedData } from './hooks/useProjectDerivedData';
import {
  getShortcutLabelMap,
  loadKeyboardShortcuts,
  saveKeyboardShortcuts,
  setCurrentShortcuts,
} from './store/keyboardShortcuts';
import { applyThemePreference, loadThemePreference, saveThemePreference } from './store/themePreference';
import { SaveProgressModal } from './components/common/SaveProgressModal';
import { GenerateProgressModal } from './components/GenerateModal/GenerateProgressModal';
import { ImportNoticeToast } from './components/common/ImportNoticeToast';
import { CreditsModal } from './components/common/CreditsModal';
import { TitleBar } from './components/layout/TitleBar';
import { Toolbar } from './components/layout/Toolbar';
import { BottomWorkspacePanel } from './components/BottomWorkspacePanel/BottomWorkspacePanel';
import { ErrorDialogProvider, useErrorDialog } from './components/common/Dialog';
import { AggregatePacksFunnel } from './components/AggregatePacks/AggregatePacksFunnel';
import { SessionMediaTriageModal } from './components/SessionMediaTriage/SessionMediaTriageModal';
import { CommunityPackCheckerFunnel } from './components/CommunityPackChecker/CommunityPackCheckerFunnel';
import { EditPackFunnel } from './components/EditPack/EditPackFunnel';
import { PodcastImportFunnel } from './components/PodcastImport/PodcastImportFunnel';
import { YoutubeImportFunnel } from './components/YoutubeImport/YoutubeImportFunnel';
import { useEscapeKey } from './hooks/useEscapeKey';
import { useAiGeneration } from './hooks/useAiGeneration';
import { useAiJobUsage } from './hooks/useAiJobUsage';
import { usePackGeneration } from './hooks/usePackGeneration';
import { useAppShortcuts } from './hooks/useAppShortcuts';
import { useAutosave } from './hooks/useAutosave';
import { useMediaImport } from './hooks/useMediaImport';
import { useMediaLibraryPaths } from './hooks/useMediaLibraryPaths';
import { useMediaTransferHandlers } from './hooks/useMediaTransferHandlers';
import { useMissingMediaRelink } from './hooks/useMissingMediaRelink';
import { usePersistentState } from './hooks/usePersistentState';
import { useProjectLifecycle } from './hooks/useProjectLifecycle';
import { useProjectLoading } from './hooks/useProjectLoading';
import { useSaveProgress } from './hooks/useSaveProgress';
import { useSessionMediaTriage } from './hooks/useSessionMediaTriage';
import { useSyncedRef } from './hooks/useSyncedRef';
import { useWindowCloseGuard } from './hooks/useWindowCloseGuard';
import { useWorkSession } from './hooks/useWorkSession';
import { useSDJobs } from './hooks/useSDJobs';
import { useXttsJobs } from './hooks/useXttsJobs';
import { useDiagramViewState } from './workspace/useDiagramViewState';
import { logger, installGlobalErrorHandlers, setLogLevel } from './utils/logger';
import { loadVerboseLoggingPref, saveVerboseLoggingPref, verboseLevelName } from './store/loggingPreference';
import { isTauriRuntime } from './utils/tauriRuntime';
import { getProjectFilePrefix } from './utils/projectPrefix';
import { END_NODE_ID } from './components/CentralPanel/flowDiagramLayout';
import './styles/variables.css';
import './styles/layout.css';
import './components/layout/AppChrome.css';
import './components/RenderQueuePanel/RenderQueuePanel.css';

const WorkspaceView = lazy(() => import('./workspace/WorkspaceView').then((module) => ({ default: module.WorkspaceView })));
const OptionsTab = lazy(() => import('./tabs/OptionsTab').then((module) => ({ default: module.OptionsTab })));
const SDGenerateModal = lazy(() => import('./components/SDGenerateModal/SDGenerateModal').then((module) => ({ default: module.SDGenerateModal })));
const RecordModal = lazy(() => import('./components/RecordModal/RecordModal').then((module) => ({ default: module.RecordModal })));
const GenerateVoiceModal = lazy(() => import('./components/GenerateVoiceModal/GenerateVoiceModal')
  .then((module) => ({ default: module.GenerateVoiceModal })));
const PackNameModal = lazy(() => import('./components/layout/PackNameModal').then((module) => ({ default: module.PackNameModal })));
const MissingMediaRelinkModal = lazy(() => import('./components/MissingMediaRelink/MissingMediaRelinkModal')
  .then((module) => ({ default: module.MissingMediaRelinkModal })));
const PodcastImportModal = lazy(() => import('./components/PodcastImport/PodcastImportModal')
  .then((module) => ({ default: module.PodcastImportModal })));

function renderDeferred(children, fallback = null) {
  return (
    <Suspense fallback={fallback}>
      {children}
    </Suspense>
  );
}

// Codecs réutilisés par les `usePersistentState` ci-dessous.
const BOOL_CODEC = { decode: (raw) => raw === 'true', encode: (value) => String(!!value) };
const INT_CODEC = {
  decode: (raw) => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  },
  encode: (value) => String(value),
};
// Retourne true si on peut continuer (sauvegardé ou confirmé non-sauvegardé),
// false si l'utilisateur a annulé ou si la sauvegarde n'a pas abouti.
// savedSnapshot : JSON.stringify du projet au moment du dernier save/load, ou null si projet vierge
async function askSaveBeforeLeave(project, savedSnapshot, onSave, showChoiceDialog) {
  // Si on a un snapshot, comparer pour détecter les vraies modifications
  // Si pas de snapshot (projet vierge), vérifier si le projet a du contenu
  const unchanged = savedSnapshot === null
    ? !isProjectDirty(project)
    : JSON.stringify(project) === savedSnapshot;
  if (unchanged) return true;
  const choice = await showChoiceDialog({
    title: 'Projet non enregistré',
    message: "Ton travail n'est pas enregistré et sera définitivement perdu.",
    variant: 'warning',
    cancelValue: 'cancel',
    actions: [
      { value: 'cancel', label: 'Annuler', autoFocus: true },
      { value: 'discard', label: 'Quitter sans enregistrer', kind: 'danger-outline' },
      { value: 'save', label: 'Enregistrer comme projet', kind: 'primary' },
    ],
  });
  if (choice === 'save') {
    try {
      const savedPath = await onSave?.();
      return !!savedPath;
    } catch {
      return false;
    }
  }
  return choice === 'discard';
}

function AppContent() {
  const store = useProjectStore();
  const { showErrorDialog, showConfirmDialog, showChoiceDialog } = useErrorDialog();
  const renderQueue = useRenderQueueStore();
  const [saveToast, setSaveToast] = useState(null); // null | 'ok' | 'error'
  const [, setAutoSavedPath] = useState(null); // path of last autosave (display only)
  const [appVersion, setAppVersion] = useState('');
  const [xttsSettings, setXttsSettings] = useState(() => loadXttsSettings());
  const [keyboardShortcuts, setKeyboardShortcuts] = useState(() => loadKeyboardShortcuts());
  const [themePreference, setThemePreference] = useState(() => loadThemePreference());
  const [recentProjects, setRecentProjects] = useState(() => getRecentProjects());
  const sdStore = useSdStore();
  const xttsStore = useXttsStore();
  useRenderQueueExecutor({ jobs: renderQueue.jobs, updateJob: renderQueue.updateJob, appendLog: renderQueue.appendLog });
  const [bottomPanelOpen, setBottomPanelOpen] = usePersistentState(KEYS.BOTTOM_PANEL_OPEN, false, BOOL_CODEC);
  const [bottomPanelTab, setBottomPanelTab] = usePersistentState(KEYS.BOTTOM_PANEL_TAB, 'media');
  const diagramView = useDiagramViewState();
  const [creditsOpen, setCreditsOpen] = useState(false);
  const [packOptionsOpen, setPackOptionsOpen] = useState(false);
  const [toolbarRecordOpen, setToolbarRecordOpen] = useState(false);
  const [toolbarTtsOpen, setToolbarTtsOpen] = useState(false);
  const [toolbarTtsTargetMenuId, setToolbarTtsTargetMenuId] = useState(null);
  const [podcastImportOpen, setPodcastImportOpen] = useState(false);
  const [podcastFunnelOpen, setPodcastFunnelOpen] = useState(false);
  // null = fermé ; 'home' = entrée accueil (session éphémère) ; 'editor' = import
  // dans le projet courant (éditeur libre). Plan 09.
  const [youtubeFunnelMode, setYoutubeFunnelMode] = useState(null);
  const [aggregatePacksOpen, setAggregatePacksOpen] = useState(false);
  const [packCheckerOpen, setPackCheckerOpen] = useState(false);
  const [copyImportedFilesEnabled, setCopyImportedFilesEnabled] = usePersistentState(KEYS.COPY_FILES, false, BOOL_CODEC);
  const [configuredWorkspaceDir, setConfiguredWorkspaceDir] = useState(() => readSetting(KEYS.WORKSPACE_DIR, { defaultValue: '' }));
  const [workspaceDir, setWorkspaceDirState] = useState(() => readSetting(KEYS.WORKSPACE_DIR, { defaultValue: '' }));
  const [useWorkspaceForNewProjects, setUseWorkspaceForNewProjects] = usePersistentState(KEYS.USE_WORKSPACE_FOR_NEW_PROJECTS, false, BOOL_CODEC);
  // « Modifier un pack » (plan 04) : ouverture du funnel + ZIP à simuler une fois l'éditeur monté.
  const [editPackOpen, setEditPackOpen] = useState(false);
  const [pendingSimulateZip, setPendingSimulateZip] = useState(null);
  // D34 : force la modal de métadonnées (version suggérée) à la 1re génération d'un
  // pack importé. Ref (pas state) : lu/écrit synchronement dans le flux de génération.
  const importedPackPendingMetaRef = useRef(false);
  const [importNotice, setImportNotice] = useState(null); // string | null
  const [activeDropZone, setActiveDropZone] = useState(null);
  // Actif par défaut (D49) ; la migration one-shot de main.jsx aligne les
  // installations existantes.
  const [autoSaveEnabled, setAutoSaveEnabled] = usePersistentState(KEYS.AUTOSAVE_ENABLED, true, BOOL_CODEC);
  const [autoSaveBackupLimit, setAutoSaveBackupLimit] = usePersistentState(KEYS.AUTOSAVE_BACKUP_LIMIT, 5, INT_CODEC);
  const [verboseLogging, setVerboseLoggingState] = useState(() => loadVerboseLoggingPref());
  const [prefsModalOpen, setPrefsModalOpen] = useState(false);
  const projectIndex = useMemo(() => buildProjectIndex(store.project), [store.project]);
  const { statusByPath: pathAudit, pending: pathAuditPending } = useProjectFileAudit(store.project, projectIndex, store.savePath);
  const aiQueueActiveCount = sdStore.pendingCount + xttsStore.pendingCount;
  const aiQueueHasResults = sdStore.hasResults || xttsStore.hasResults;
  const projectRef = useRef(store.project);
  const savePathRef = useRef(store.savePath);
  const workspaceDirRef = useRef(readSetting(KEYS.WORKSPACE_DIR, { defaultValue: '' }));
  const mediaTagsRef = useRef(store.mediaTags);
  const mediaLibraryCountRef = useRef(0);
  const saveHandlerRef = useRef(null);
  const saveAsHandlerRef = useRef(null);
  const isSavingRef = useRef(false);
  const persistProjectSnapshotRef = useRef(null);
  const autoSavePathRef = useRef(null); // path of last autosave for never-manually-saved projects
  const shortcutActionsRef = useRef({});
  const keyboardShortcutsRef = useRef(keyboardShortcuts);
  const [treeSearchFocusTrigger, setTreeSearchFocusTrigger] = useState(0);
  const [validationOpen, setValidationOpen] = useState(false);
  const dismissedTransferPromptRef = useRef(null);
  // null = projet vierge (jamais sauvegardé/chargé) ; sinon JSON du projet au dernier save/load
  const savedSnapshotRef = useRef(null);

  useEffect(() => { getVersion().then(setAppVersion).catch(() => {}); }, []);

  useEffect(() => {
    const detach = installGlobalErrorHandlers();
    const verbose = loadVerboseLoggingPref();
    const level = verboseLevelName(verbose);
    setLogLevel(level);
    if (isTauriRuntime()) {
      invoke('set_log_level', { level })
        .then(() => {
          logger.info(`boot:verbose-enabled value=${verbose} runtime=tauri ua=${navigator.userAgent.slice(0, 80)}`);
        })
        .catch(() => {});
    }
    return detach;
  }, []);

  projectRef.current = store.project;
  savePathRef.current = store.savePath;
  mediaTagsRef.current = store.mediaTags;

  useEffect(() => {
    workspaceDirRef.current = workspaceDir;
  }, [workspaceDir]);

  useEffect(() => {
    keyboardShortcutsRef.current = keyboardShortcuts;
    setCurrentShortcuts(keyboardShortcuts);
    saveKeyboardShortcuts(keyboardShortcuts);
  }, [keyboardShortcuts]);

  useEffect(() => {
    const cleanup = applyThemePreference(themePreference);
    saveThemePreference(themePreference);
    return cleanup;
  }, [themePreference]);

  useEffect(() => {
    if (!copyImportedFilesEnabled) dismissedTransferPromptRef.current = null;
  }, [copyImportedFilesEnabled]);

  useEffect(() => {
    if (renderQueue.panelOpen) {
      setBottomPanelOpen(true);
      setBottomPanelTab('queue');
      renderQueue.setPanelOpen(false);
    }
  }, [renderQueue.panelOpen, renderQueue.setPanelOpen]);

  useAppShortcuts({ actionsRef: shortcutActionsRef, keyboardShortcutsRef, saveHandlerRef, saveAsHandlerRef });

  // mediaLibraryPathsRef est consomme par useWorkSession et useAutosave juste
  // apres ; sa declaration doit donc preceder. (Bug TDZ latent dans le code
  // historique, declenche par certains modes de build/runtime.)
  const {
    mediaLibraryPaths,
    mediaLibraryPathsRef,
    setMediaLibraryPaths,
    addPathsToMediaLibrary,
    handleMediaCreated,
    handleDeleteMedia,
  } = useMediaLibraryPaths({ store, sdStore, xttsStore, workspaceDirRef });

  // Machine à sessions (éphémère/projet, reprises après crash, snapshot
  // anti-crash) : toutes les transitions et le nettoyage du dossier de session
  // vivent dans useWorkSession.
  const {
    sessionMode,
    sessionWorkspaceDir,
    sessionRecoveries,
    sessionModeRef,
    ephemeralSnapshotPathRef,
    ephemeralSavedSnapshotRef,
    prepareNewWorkSession,
    cleanupEphemeralSession,
    resetWorkSession,
    runFunnelLanding,
    promoteSessionToProject,
    enterProjectMode,
    handleRecoverSession,
    handleIgnoreSessionRecovery,
  } = useWorkSession({
    store,
    sdStore,
    xttsStore,
    showErrorDialog,
    useWorkspaceForNewProjects,
    configuredWorkspaceDir,
    setConfiguredWorkspaceDir,
    setWorkspaceDirState,
    workspaceDirRef,
    savedSnapshotRef,
    autoSavePathRef,
    setAutoSavedPath,
    setMediaLibraryPaths,
    mediaTagsRef,
    mediaLibraryPathsRef,
    mediaLibraryCountRef,
    importedPackPendingMetaRef,
  });

  useEffect(() => {
    let cancelled = false;
    ensureWorkspaceDir().then((dir) => {
      if (cancelled) return;
      setConfiguredWorkspaceDir(dir);
      if (sessionModeRef.current !== 'ephemeral') {
        setWorkspaceDirState(dir);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const askSaveBeforeLeaveCurrent = useCallback(async (project, savedSnapshot, onSave) => {
    const canLeave = await askSaveBeforeLeave(project, savedSnapshot, onSave, showChoiceDialog);
    if (canLeave) await cleanupEphemeralSession();
    return canLeave;
  }, [cleanupEphemeralSession, showChoiceDialog]);

  useWindowCloseGuard({
    askSaveBeforeLeave: askSaveBeforeLeaveCurrent,
    projectRef,
    savedSnapshotRef,
    saveHandlerRef,
  });

  useAutosave({
    enabled: autoSaveEnabled || sessionMode === 'ephemeral',
    backupLimit: autoSaveBackupLimit,
    projectRef,
    savedSnapshotRef,
    savePathRef,
    workspaceDirRef,
    autoSavePathRef,
    ephemeralSnapshotPathRef,
    ephemeralSavedSnapshotRef,
    sessionModeRef,
    isSavingRef,
    mediaTagsRef,
    mediaLibraryPathsRef,
    mediaLibraryCountRef,
    setAutoSavedPath,
    setSaveToast,
    saveHandlerRef,
  });

  useEscapeKey(creditsOpen, () => setCreditsOpen(false));

  // Dispatch de génération IA (SD/ComfyUI + XTTS) + application d'un audio généré
  // à sa cible. Appelé AVANT useSDJobs/useXttsJobs : applyGeneratedAudioToTarget
  // leur est passé et doit exister au moment du câblage.
  const {
    handleOpenAiQueue,
    handleOpenSDGenerate,
    handleRegenerateImageJob,
    handleSDGenerate,
    applyGeneratedAudioToTarget,
    handleQueueXttsGenerate,
    sdGenerate,
  } = useAiGeneration({
    store,
    sdStore,
    xttsStore,
    projectIndex,
    xttsSettings,
    setBottomPanelOpen,
    setBottomPanelTab,
  });

  useSDJobs(sdStore, workspaceDir, handleMediaCreated);
  useXttsJobs(xttsStore, applyGeneratedAudioToTarget, workspaceDir, handleMediaCreated);

  const { getAudioJobUsage, getImageJobUsage } = useAiJobUsage({ project: store.project, projectIndex });

  // Grappe « générer le pack » (plan J, iso-fonctionnel) : étape métadonnées
  // (PackNameModal), gardes de validation, résolution du dossier d'export et
  // enfilement du job dans la file de rendu. `importedPackPendingMetaRef` est
  // partagée avec useWorkSession (D34) : le hook la lit et la remet à false.
  const {
    handleGenerate,
    handleSavePackMetadata,
    packMetadata,
  } = usePackGeneration({
    store,
    renderQueue,
    pathAudit,
    pathAuditPending,
    workspaceDirRef,
    importedPackPendingMetaRef,
    showErrorDialog,
    showChoiceDialog,
  });

  const handleUpdateRoot = useCallback(({ projectName, name, rootName, endNodeName, packMetadata }) => {
    const nextProjectName = projectName ?? name;
    if (nextProjectName !== undefined) store.updateProjectName(nextProjectName);
    if (rootName !== undefined || endNodeName !== undefined || packMetadata !== undefined) {
      store.setProject(p => ({
        ...p,
        ...(rootName !== undefined ? { rootName } : {}),
        ...(endNodeName !== undefined ? { endNodeName } : {}),
        ...(packMetadata !== undefined
          ? { packMetadata: { ...(p.packMetadata ?? {}), ...packMetadata } }
          : {}),
      }));
    }
  }, [store.updateProjectName, store.setProject]);

  const handleAddMenu = useCallback((parentMenuId = null) => {
    return store.addMenu(parentMenuId);
  }, [store.addMenu]);

  const handleReorder = useCallback((menuId, newItems) => {
    if (menuId == null) store.reorderRootItems(newItems);
    else store.reorderMenuItems(menuId, newItems);
  }, [store.reorderRootItems, store.reorderMenuItems]);

  const handleUpdateMenu = useCallback((fields, menuId = store.selectedId) => {
    if (menuId) store.updateMenu(menuId, fields);
  }, [store.updateMenu, store.selectedId]);

  const handleDeleteMenu = useCallback((menuId = store.selectedId) => {
    const resolvedId = typeof menuId === 'string' ? menuId : store.selectedId;
    if (resolvedId) store.deleteMenu(resolvedId);
  }, [store.deleteMenu, store.selectedId]);

  const handleSetMenuAsRoot = useCallback((menuId) => {
    store.promoteMenuToRoot(menuId);
  }, [store.promoteMenuToRoot]);

  const handleDemoteRootToMenu = useCallback(() => {
    store.demoteRootToMenu();
  }, [store.demoteRootToMenu]);

  const handleUpdateItem = useCallback((fields, itemId = store.selectedId) => {
    if (itemId) store.updateItem(itemId, fields);
  }, [store.updateItem, store.selectedId]);

  const handleBulkUpdateItems = useCallback((ids, getFields) => {
    store.bulkUpdateItems(ids, getFields);
  }, [store.bulkUpdateItems]);

  const handleBulkDeleteItems = useCallback((ids) => {
    store.bulkDeleteItems(ids);
  }, [store.bulkDeleteItems]);

  const handleDeleteItem = useCallback((itemId = store.selectedId) => {
    const resolvedId = typeof itemId === 'string' ? itemId : store.selectedId;
    if (resolvedId) store.deleteItem(resolvedId);
  }, [store.deleteItem, store.selectedId]);

  const {
    maybeCopyToProject,
    copyGeneratedMediaToProject,
    dropOnNode,
    notifyCutPaste,
    extractAudioEmbeddedImage,
    maybeOfferTransferIntoProject,
    handleCopyImportedFilesChange,
  } = useMediaTransferHandlers({
    store,
    copyImportedFilesEnabled,
    setCopyImportedFilesEnabled,
    workspaceDir,
    setWorkspaceDirState,
    workspaceDirRef,
    savePathRef,
    pathAudit,
    dismissedTransferPromptRef,
    setSaveToast,
    persistProjectSnapshotRef,
    showErrorDialog,
    addPathsToMediaLibrary,
  });

  const mediaLibraryCount = useMemo(
    () => collectMediaLibrary({ project: store.project, statusByPath: pathAudit, sdJobs: sdStore.jobs, xttsJobs: xttsStore.jobs, extraPaths: mediaLibraryPaths }).length,
    [store.project, pathAudit, sdStore.jobs, xttsStore.jobs, mediaLibraryPaths],
  );
  mediaLibraryCountRef.current = mediaLibraryCount;

  async function handlePickWorkspaceDir() {
    const chosen = await pickWorkspaceDir();
    if (chosen) {
      logger.info(`workspace:switched path='${chosen}'`);
      setConfiguredWorkspaceDir(chosen);
      if (sessionMode !== 'ephemeral') {
        setWorkspaceDirState(chosen);
      }
    }
  }

  async function handleVerboseLoggingChange(enabled) {
    setVerboseLoggingState(enabled);
    saveVerboseLoggingPref(enabled);
    const level = verboseLevelName(enabled);
    setLogLevel(level);
    if (isTauriRuntime()) {
      try { await invoke('set_log_level', { level }); }
      catch (err) { logger.error('logging:set-level-error', err); }
    }
    logger.warn(`logging:level-changed level=${level}`);
  }

  function logDirOf(filePath) {
    if (typeof filePath !== 'string' || !filePath) return null;
    return filePath.replace(/[\\/][^\\/]*$/, '') || filePath;
  }

  async function handleResolveLogPath() {
    if (!isTauriRuntime()) return null;
    try {
      const file = await invoke('get_current_log_file');
      return logDirOf(file);
    } catch (err) {
      logger.error('logging:resolve-path-error', err);
      return null;
    }
  }

  async function handleCopyLogPath() {
    if (!isTauriRuntime()) return null;
    try {
      const file = await invoke('get_current_log_file');
      const dir = logDirOf(file);
      if (!dir) return null;
      await navigator.clipboard.writeText(dir);
      return dir;
    } catch (err) {
      logger.error('logging:copy-path-error', err);
      return null;
    }
  }

  async function handleConsolidateProject() {
    const destinationDir = await openDialog({
      directory: true,
      multiple: false,
      title: 'Choisir le dossier de consolidation',
    });
    if (!destinationDir) return null;
    setSaveProgress({ lines: ['Consolidation du projet...'], complete: false });
    try {
      const result = await consolidateProject(store.project, store.savePath, destinationDir, (step) => {
        setSaveProgress(prev => prev ? { ...prev, lines: [...prev.lines, step] } : { lines: [step], complete: false });
      });
      const summary = `${result.copiedCount} fichier(s) copié(s)`;
      const warnings = result.errors.length > 0 ? `, ${result.errors.length} erreur(s)` : '';
      setSaveProgress(prev => prev ? { ...prev, lines: [...prev.lines, `${summary}${warnings}`], complete: true } : null);
      setTimeout(() => setSaveProgress(null), 2200);
      if (result.path && result.project) {
        setRecentProjects(rememberRecentProject(result.project, result.path));
      }
      if (result.errors.length > 0) {
        showErrorDialog({
          title: 'Projet consolidé',
          message: `Projet consolidé avec des fichiers manquants :\n\n${result.errors.slice(0, 5).map((error) => `• ${error.path}\n  ${error.error}`).join('\n')}`,
          variant: 'warning',
        });
      }
      return result;
    } catch (error) {
      setSaveProgress(null);
      showErrorDialog({
        title: 'Consolidation impossible',
        message: `Consolidation impossible : ${error}`,
      });
      return null;
    }
  }

  // Tri des médias de session non utilisés à la promotion (plan 22, D51).
  const { triageSessionMedia, triageRequest } = useSessionMediaTriage({
    store,
    mediaLibraryPathsRef,
    setMediaLibraryPaths,
    showChoiceDialog,
  });

  const {
    saveProgress,
    saveAsProgress,
    setSaveProgress,
    handleSave,
    handleSaveProject,
    handleSaveProjectAs,
    persistProjectSnapshot,
  } = useSaveProgress({
    store,
    workspaceDirRef,
    mediaLibraryPathsRef,
    autoSaveEnabled,
    autoSaveBackupLimit,
    savedSnapshotRef,
    sessionModeRef,
    isSavingRef,
    setSaveToast,
    setRecentProjects,
    maybeOfferTransferIntoProject,
    triageSessionMedia: ({ project, savePath, targetWorkspaceDir, transferCopies }) => triageSessionMedia({
      project,
      sessionDir: sessionWorkspaceDir,
      targetWorkspaceDir,
      transferCopies,
      projectName: getProjectFilePrefix(project, savePath),
    }),
    onProjectSaved: async (_result, options = {}) => {
      // Seule la promotion « Enregistrer comme projet » (handleSaveProjectAs) nettoie
      // le dossier de session et bascule en mode projet. Un enregistrement en place
      // (handleSaveProject) ne doit JAMAIS supprimer la session éphémère en cours.
      if (!options.promote) return;
      promoteSessionToProject({
        workspaceDir: options.workspaceDir,
        cleanupSession: options.cleanupSession,
      });
    },
  });
  useSyncedRef(persistProjectSnapshotRef, persistProjectSnapshot);

  const { handleLoad, handleLoadRecent } = useProjectLoading({
    store,
    sdStore,
    xttsStore,
    setMediaLibraryPaths,
    setRecentProjects,
    savedSnapshotRef,
    autoSavePathRef,
    setAutoSavedPath,
    handleSave,
    showErrorDialog,
    isProjectDirty,
    showChoiceDialog,
    onProjectLoaded: enterProjectMode,
    onBeforeProjectReplaced: cleanupEphemeralSession,
  });

  // Plan 01 (révisé) : on ne propose plus d'enregistrer le projet source APRÈS
  // génération. La proposition ne subsiste qu'à la sortie de l'app / au remplacement
  // du travail courant (useWindowCloseGuard / useProjectLoading), jamais forcée.

  const {
    missingMedia,
    missingMediaSignature,
    dismissedMissingMediaSignature,
    setDismissedMissingMediaSignature,
    handleApplyMissingMediaRelinks,
  } = useMissingMediaRelink({
    store,
    mediaLibraryPathsRef,
    setMediaLibraryPaths,
    pathAudit,
    handleSaveProject,
  });

  // Grappe « funnels média d'accueil » (plan L, iso-fonctionnel) : atterrissage
  // podcast/YouTube + regroupement des appels d'import déjà-hookés
  // (useImportSession/useOsFileDrop, ré-exposés). Appelée APRÈS useMediaTransferHandlers
  // (copy-handlers), useSaveProgress (persistProjectSnapshot) et useWorkSession
  // (runFunnelLanding), et AVANT ses consommateurs (ProjectActionsContext,
  // useProjectLifecycle qui lit unpackZipIntoBlankProject).
  const {
    handleAddStory,
    handleAddStoryToMenu,
    handleImportFolder,
    handleUnpackZip,
    unpackZipIntoBlankProject,
    handleImportMediaLibrary,
    handleImportMediaLibraryFolder,
    handleImportMediaEpisodes,
    importing,
    unpacking,
    handlePodcastFunnelImport,
    handleYoutubeFunnelImport,
    handleYoutubeEditorImport,
  } = useMediaImport({
    store,
    projectIndex,
    maybeCopyToProject,
    copyGeneratedMediaToProject,
    extractAudioEmbeddedImage,
    addPathsToMediaLibrary,
    persistProjectSnapshot,
    workspaceDirRef,
    importedPackPendingMetaRef,
    runFunnelLanding,
    setImportNotice,
    setActiveDropZone,
    showErrorDialog,
  });

  // Cycle de vie du projet (plan K, iso-fonctionnel) : nouveau projet (reset vers
  // l'accueil), choix du type (session éphémère) et atterrissage depuis les funnels
  // « Modifier un pack » (éditable) / « Simuler » (non éditable). Appelée APRÈS
  // useWorkSession, useSaveProgress et useMediaImport : elle consomme
  // runFunnelLanding/prepareNewWorkSession/resetWorkSession, handleSave et
  // unpackZipIntoBlankProject (ré-exposé par useMediaImport).
  // askSaveBeforeLeaveCurrent reste chez l'hôte (garde
  // partagée avec useWindowCloseGuard) et lui est passée en entrée.
  const {
    handleNewProject,
    handleSelectProjectType,
    handleEditExistingPack,
    handleLandEditablePack,
    handleSimulatePackReady,
  } = useProjectLifecycle({
    store,
    askSaveBeforeLeaveCurrent,
    handleSave,
    prepareNewWorkSession,
    runFunnelLanding,
    resetWorkSession,
    unpackZipIntoBlankProject,
    savedSnapshotRef,
    autoSavePathRef,
    importedPackPendingMetaRef,
    setMediaLibraryPaths,
    setAutoSavedPath,
    sdStore,
    xttsStore,
    setEditPackOpen,
    setPendingSimulateZip,
    setImportNotice,
    showErrorDialog,
  });

  useSyncedRef(saveHandlerRef, handleSave);
  useSyncedRef(saveAsHandlerRef, handleSaveProjectAs);

  async function handleUpdateGlobalOption(key, value) {
    store.updateGlobalOption(key, value);
  }

  function handleAddEndNode() {
    store.updateGlobalOption('endNode', true);
    store.setSelectedId('end-node');
  }

  async function handleRemoveEndNode(options = {}) {
    if (!options?.skipConfirm) {
      const confirmed = await showConfirmDialog({
        title: 'Supprimer le message de fin',
        message:
          "Supprimer le message de fin du pack ?\n\n"
          + "Les histoires ne joueront plus de message commun à leur conclusion. Le mode nuit sera aussi désactivé.",
        variant: 'warning',
        okLabel: 'Supprimer',
        okKind: 'danger',
        cancelLabel: 'Annuler',
      });
      if (!confirmed) return false;
    }

    store.updateRootMedia('nightModeAudio', null);
    store.updateRootMedia('nightModeReturn', null);
    store.updateRootMedia('nightModeHomeReturn', null);
    store.updateGlobalOption('nightMode', false);
    store.updateGlobalOption('endNode', false);
    store.setSelectedId('root');
    return true;
  }

  function handleUpdateXttsSettings(fields) {
    setXttsSettings(prev => {
      const next = { ...prev, ...fields };
      saveXttsSettings(next);
      return next;
    });
  }

  const sel = store.selectedId;
  const {
    selectedNode,
    validationIssues,
    allMenus,
  } = useProjectDerivedData(store.project, {
    selectedId: sel,
    fileAudit: pathAudit,
    projectIndex,
  });

  const { projectType } = store.project;
  const showMissingMediaRelink = projectType !== null
    && !!store.savePath
    && !pathAuditPending
    && missingMedia.length > 0
    && missingMediaSignature !== dismissedMissingMediaSignature;
  const errors = validationIssues.filter((issue) => issue.status === 'error').length;
  const warnings = validationIssues.filter((issue) => issue.status === 'warning').length;
  const totalIssues = errors + warnings;

  const selectedStatusName = useMemo(() => {
    if (projectType === null) return null;
    if (store.selectedId === END_NODE_ID) return store.project.endNodeName || 'Message de fin';
    if (store.selectedId === 'root') {
      return projectType === 'simple'
        ? (store.project.projectName || 'Mon histoire')
        : (store.project.rootName || store.project.projectName || 'Menu racine');
    }
    const entry = projectIndex.entryById.get(store.selectedId);
    return entry?.name || '(sans nom)';
  }, [projectIndex, projectType, store.project, store.selectedId]);
  const activePanelsLabel = [
    diagramView.showTree && 'arbre',
    diagramView.showSettings && 'réglages',
    diagramView.showDiagram && 'diagramme',
  ].filter(Boolean).join(' + ');
  const statusText = projectType === null
    ? 'Choisis un type de projet'
    : `Sélection : ${selectedStatusName} — panneaux : ${activePanelsLabel}`;
  const projectDirty = savedSnapshotRef.current === null
    ? isProjectDirty(store.project)
    : JSON.stringify(store.project) !== savedSnapshotRef.current;
  const titleBarName = store.project.projectName?.trim() || null;
  const canImportStories = store.project.projectType === 'pack';
  const canAddFolder = canImportStories;
  const canRecord = canImportStories;
  const canGenerateStoryTts = canImportStories && isTtsAvailable(xttsSettings);
  const shortcutLabels = useMemo(() => getShortcutLabelMap(keyboardShortcuts), [keyboardShortcuts]);
  const effectiveProjectFilePrefix = getProjectFilePrefix(store.project, store.savePath);
  const lastExportDir = getLastExportDir();
  const modalExportFolder = (() => {
    if (lastExportDir) return lastExportDir;
    const ws = workspaceDirRef.current || readSetting(KEYS.WORKSPACE_DIR, { defaultValue: '' });
    if (!ws) return null;
    const trimmed = ws.replace(/[\\/]+$/, '');
    const sep = ws.includes('\\') ? '\\' : '/';
    return `${trimmed}${sep}exports`;
  })();

  function handleToolbarRecord() {
    setToolbarRecordOpen(true);
  }

  function toolbarTargetMenuId() {
    const selId = store.selectedId;
    const entry = selId && selId !== 'root' ? projectIndex.entryById.get(selId) : null;
    if (!entry) return null;
    if (entry.type === 'menu') return selId;
    return projectIndex.parentMenuById.get(selId) ?? null;
  }

  function handleToolbarStoryTts() {
    setToolbarTtsTargetMenuId(toolbarTargetMenuId());
    setToolbarTtsOpen(true);
  }

  function handleToolbarRecordSaved(path) {
    store.addStory(toolbarTargetMenuId(), path);
    setToolbarRecordOpen(false);
  }
  const canGenerate = projectType !== null && !pathAuditPending && totalIssues === 0;

  useSyncedRef(shortcutActionsRef, {
    newProject: handleNewProject,
    openProject: handleLoad,
    importStories: handleAddStory,
    addFolder: () => store.addMenu(),
    openPackOptions: () => setPackOptionsOpen(true),
    openPreferences: () => setPrefsModalOpen(true),
    toggleTree: diagramView.toggleTree,
    toggleSettings: diagramView.toggleSettings,
    toggleDiagram: diagramView.toggleDiagram,
    generate: handleGenerate,
    focusTreeSearch: () => setTreeSearchFocusTrigger((n) => n + 1),
    toggleValidation: () => setValidationOpen((open) => !open),
    undo: store.undo,
    redo: store.redo,
    projectActionsVisible: projectType !== null,
    treeSearchVisible: diagramView.treeVisible,
    canImportStories,
    canAddFolder,
    canGenerate,
    canUndo: store.canUndo,
    canRedo: store.canRedo,
    hasValidationErrors: totalIssues > 0,
  });

  // Actions projet partagées entre les surfaces d'édition (arbre, réglages, diagramme),
  // consommées via useProjectActions. Noms canoniques : onImportStories = sélecteur
  // de fichiers vers la racine ; onAddStoryToMenu = sélecteur vers un menu cible.
  const projectActions = {
    onSelect: store.setSelectedId,
    onReorder: handleReorder,
    onMoveToMenu: store.moveItemToMenu,
    onAddMenu: handleAddMenu,
    onAddStoryToMenu: handleAddStoryToMenu,
    onImportStories: handleAddStory,
    onImportFolder: handleImportFolder,
    onImportPodcast: () => setPodcastImportOpen(true),
    onImportYoutube: () => setYoutubeFunnelMode('editor'),
    onRecord: handleToolbarRecord,
    onGenerateStoryTts: handleToolbarStoryTts,
    canRecord,
    canGenerateStoryTts,
    onUnpackZip: handleUnpackZip,
    onUpdateRoot: handleUpdateRoot,
    onUpdateMedia: store.updateRootMedia,
    onUpdateStoryAudio: store.updateStoryAudio,
    onUpdateMenu: handleUpdateMenu,
    onDeleteMenu: handleDeleteMenu,
    onUpdateItem: handleUpdateItem,
    onDeleteItem: handleDeleteItem,
    onBulkUpdateItems: handleBulkUpdateItems,
    onBulkDeleteItems: handleBulkDeleteItems,
    onSetMenuAsRoot: handleSetMenuAsRoot,
    onDemoteRootToMenu: handleDemoteRootToMenu,
    onDuplicate: store.duplicateEntry,
    onPasteEntries: store.pasteEntriesToMenu,
    onCutPasteEntries: store.cutPasteEntriesToMenu,
    onAddEndNode: handleAddEndNode,
    onRemoveEndNode: handleRemoveEndNode,
    onUpdateNightModeAudio: (value) => store.updateRootMedia('nightModeAudio', value),
    onUpdateNightMode: (value) => store.updateGlobalOption('nightMode', value),
    onUpdateNightModeReturn: (value) => store.updateRootMedia('nightModeReturn', value),
    onUpdateNightModeHomeReturn: (value) => store.updateRootMedia('nightModeHomeReturn', value),
  };

  const optionsTabProps = {
    copyFilesEnabled: copyImportedFilesEnabled,
    onCopyFilesChange: handleCopyImportedFilesChange,
    workspaceDir,
    configuredWorkspaceDir,
    onPickWorkspaceDir: handlePickWorkspaceDir,
    useWorkspaceForNewProjects,
    onUseWorkspaceForNewProjectsChange: setUseWorkspaceForNewProjects,
    onConsolidateProject: handleConsolidateProject,
    autoSaveEnabled,
    onAutoSaveChange: setAutoSaveEnabled,
    autoSaveBackupLimit,
    onAutoSaveBackupLimitChange: setAutoSaveBackupLimit,
    themePreference,
    onThemePreferenceChange: setThemePreference,
    keyboardShortcuts,
    onUpdateKeyboardShortcuts: setKeyboardShortcuts,
    xttsSettings,
    onUpdateXttsSettings: handleUpdateXttsSettings,
    sdSettings: sdStore.sdSettings,
    onUpdateSdSettings: sdStore.updateSdSettings,
    verboseLogging,
    onVerboseLoggingChange: handleVerboseLoggingChange,
    onCopyLogPath: handleCopyLogPath,
    onResolveLogPath: handleResolveLogPath,
    project: store.project,
    savePath: store.savePath,
  };

  return (
    <MediaTransferProvider
      dropOnNode={dropOnNode}
      notifyCutPaste={notifyCutPaste}
      activeDropZone={activeDropZone}
      setActiveDropZone={setActiveDropZone}
    >
    <ProjectContext.Provider value={{
      savePath: store.savePath,
      projectName: effectiveProjectFilePrefix,
      workspaceDir,
      globalOptions: store.project.globalOptions,
      xttsSettings,
      sdSettings: sdStore.sdSettings,
      sdJobs: sdStore.jobs,
      xttsJobs: xttsStore.jobs,
      pathAudit,
      onImportFile: maybeCopyToProject,
      onExtractAudioEmbeddedImage: extractAudioEmbeddedImage,
      onSave: handleSaveProject,
      onOpenSDGenerate: handleOpenSDGenerate,
      onRemoveSdResult: sdStore.removeResult,
      onUpdateXttsSettings: handleUpdateXttsSettings,
      onQueueXttsGenerate: handleQueueXttsGenerate,
      onMediaCreated: handleMediaCreated,
    }}>
    <ProjectActionsContext.Provider value={projectActions}>
    <div className="app">
      <TitleBar
        projectName={titleBarName}
        packMetadata={projectType === 'pack'
          ? store.project.packMetadata
          : projectType === 'simple'
            ? {
                ...(store.project.packMetadata ?? {}),
                title: store.project.packMetadata?.title || store.project.projectName || '',
              }
            : null}
        packCoverImage={projectType !== null ? (store.project.thumbnailImage || store.project.rootImage) : null}
        isDirty={projectDirty}
        hasSavePath={!!store.savePath}
        saveState={saveToast}
        showProjectMeta={projectType !== null}
        onOpenPackMetadata={projectType !== null ? packMetadata.openPackMetadata : null}
        onOpenCredits={() => setCreditsOpen(true)}
      />

      {projectType !== null && (
        <Toolbar
          showProjectActions={projectType !== null}
          shortcutLabels={shortcutLabels}
          saveState={saveToast}
          generateDisabled={!canGenerate}
          onNewProject={handleNewProject}
          onOpenProject={handleLoad}
          onSaveProject={handleSave}
          onSaveProjectAs={handleSaveProjectAs}
          panels={{
            showTree: diagramView.showTree,
            showSettings: diagramView.showSettings,
            showDiagram: diagramView.showDiagram,
          }}
          onToggleTree={diagramView.toggleTree}
          onToggleSettings={diagramView.toggleSettings}
          onToggleDiagram={diagramView.toggleDiagram}
          packOptionsOpen={packOptionsOpen}
          onPackOptionsOpenChange={setPackOptionsOpen}
          projectType={store.project.projectType}
          globalOptions={store.project.globalOptions}
          onUpdateGlobalOption={handleUpdateGlobalOption}
          onOpenPreferences={() => setPrefsModalOpen(true)}
          onGenerate={handleGenerate}
          validationIssues={validationIssues}
          pathAuditPending={pathAuditPending}
          validationOpen={validationOpen}
          onValidationOpenChange={setValidationOpen}
          onSelectIssue={(id) => {
            if (!id) return;
            store.setSelectedId(id);
            if (!diagramView.showSettings) diagramView.restoreSettings();
          }}
        />
      )}

      <div className="chrome-shell">
        <div className="chrome-content">
          {renderDeferred(
            <WorkspaceView
              project={store.project}
              node={selectedNode}
              selectedId={store.selectedId}
              onSetProjectType={handleSelectProjectType}
              onEditPack={handleEditExistingPack}
              onPodcastFunnel={() => setPodcastFunnelOpen(true)}
              onYoutubeFunnel={() => setYoutubeFunnelMode('home')}
              onAggregatePacks={() => setAggregatePacksOpen(true)}
              onCheckPack={() => setPackCheckerOpen(true)}
              pendingSimulateZipPath={pendingSimulateZip}
              onSimulateConsumed={() => setPendingSimulateZip(null)}
              onOpenProject={handleLoad}
              onOpenPreferences={() => setPrefsModalOpen(true)}
              recentProjects={recentProjects}
              onOpenRecentProject={handleLoadRecent}
              sessionRecoveries={sessionRecoveries}
              onRecoverSession={handleRecoverSession}
              onIgnoreSessionRecovery={handleIgnoreSessionRecovery}
              pathAudit={pathAudit}
              validationIssues={validationIssues}
              allMenus={allMenus}
              projectIndex={projectIndex}
              treeSearchFocusTrigger={treeSearchFocusTrigger}
              onFocusTreeSearch={() => setTreeSearchFocusTrigger((n) => n + 1)}
              diagramView={diagramView}
            />,
          )}
          {projectType !== null && bottomPanelOpen && (
            <BottomWorkspacePanel
              activeTab={bottomPanelTab}
              onActiveTabChange={setBottomPanelTab}
              onClose={() => setBottomPanelOpen(false)}
              project={store.project}
              pathAudit={pathAudit}
              sdJobs={sdStore.jobs}
              xttsJobs={xttsStore.jobs}
              mediaLibraryPaths={mediaLibraryPaths}
              onImportStories={() => handleAddStory()}
              onImportMedia={handleImportMediaLibrary}
              onImportMediaFolder={handleImportMediaLibraryFolder}
              onOpenAiQueue={handleOpenAiQueue}
              onRegenerateImage={handleRegenerateImageJob}
              onClearAiDone={() => {
                sdStore.clearDone();
                xttsStore.clearDone();
              }}
              onRemoveImageJob={sdStore.removeJob}
              onRemoveAudioJob={xttsStore.removeJob}
              getAudioUsage={getAudioJobUsage}
              getImageUsage={getImageJobUsage}
              onSelectNode={(id) => {
                store.setSelectedId(id);
                if (!diagramView.showSettings) diagramView.restoreSettings();
              }}
              renderQueue={renderQueue}
              mediaTags={store.mediaTags}
              onAddMediaTag={store.addMediaTag}
              onRemoveMediaTag={store.removeMediaTag}
              onDeleteMedia={handleDeleteMedia}
              savePath={store.savePath}
              projectName={effectiveProjectFilePrefix}
              onMediaCreated={handleMediaCreated}
            />
          )}
        </div>
      </div>

      {prefsModalOpen && renderDeferred(
        <OptionsTab
          {...optionsTabProps}
          asModal
          onClose={() => setPrefsModalOpen(false)}
        />,
      )}

      {toolbarRecordOpen && renderDeferred(
        <RecordModal
          savePath={store.savePath}
          workspaceDir={workspaceDir}
          projectName={effectiveProjectFilePrefix}
          onSaved={handleToolbarRecordSaved}
          onDiscarded={handleMediaCreated}
          onClose={() => setToolbarRecordOpen(false)}
        />
      )}

      {toolbarTtsOpen && canGenerateStoryTts && renderDeferred(
        <GenerateVoiceModal
          savePath={store.savePath}
          xttsSettings={xttsSettings}
          label="Nouvelle histoire"
          initialText=""
          filenameHint="histoire-tts"
          target={{ kind: 'newStory', menuId: toolbarTtsTargetMenuId }}
          onUpdateXttsSettings={handleUpdateXttsSettings}
          onQueueGenerate={handleQueueXttsGenerate}
          onClose={() => setToolbarTtsOpen(false)}
        />,
      )}

      {podcastImportOpen && renderDeferred(
        <PodcastImportModal
          onImport={(episodes, feed) => handleImportMediaEpisodes(episodes, feed)}
          onClose={() => setPodcastImportOpen(false)}
        />,
      )}

      {editPackOpen && (
        <EditPackFunnel
          onClose={() => setEditPackOpen(false)}
          onLand={handleLandEditablePack}
          onSimulate={handleSimulatePackReady}
        />
      )}

      {podcastFunnelOpen && (
        <PodcastImportFunnel
          onClose={() => setPodcastFunnelOpen(false)}
          onImport={handlePodcastFunnelImport}
        />
      )}

      {youtubeFunnelMode && (
        <YoutubeImportFunnel
          mode={youtubeFunnelMode}
          onClose={() => setYoutubeFunnelMode(null)}
          onImport={youtubeFunnelMode === 'editor' ? handleYoutubeEditorImport : handleYoutubeFunnelImport}
        />
      )}

      {aggregatePacksOpen && (
        <AggregatePacksFunnel
          onClose={() => setAggregatePacksOpen(false)}
        />
      )}

      {packCheckerOpen && (
        <CommunityPackCheckerFunnel
          onClose={() => setPackCheckerOpen(false)}
        />
      )}

      {packMetadata.open && renderDeferred(
        <PackNameModal
          open={packMetadata.open}
          packMetadata={{
            ...(store.project.packMetadata ?? {}),
            // Titre pré-rempli si vide : nom du menu racine (pack) puis nom du
            // projet, en cohérence avec le titre affiché dans RootEditor.
            title: store.project.packMetadata?.title
              || (projectType === 'pack' ? store.project.rootName : '')
              || store.project.projectName
              || '',
          }}
          project={store.project}
          coverImage={store.project.thumbnailImage || store.project.rootImage}
          exportFolder={modalExportFolder}
          generateDisabled={!canGenerate}
          promptRegenerateUuid={importedPackPendingMetaRef.current}
          onSave={(draft) => handleSavePackMetadata(draft, { generate: false })}
          onSaveAndGenerate={(draft) => handleSavePackMetadata(draft, { generate: true })}
          onClose={packMetadata.close}
        />,
      )}

      {/* SD — modale de génération */}
      {sdGenerate.open && renderDeferred(
        <SDGenerateModal
          sdSettings={sdStore.sdSettings}
          onGenerate={handleSDGenerate}
          currentImagePath={sdGenerate.context?.currentImagePath ?? null}
          currentImageLabel={sdGenerate.context?.currentImageLabel ?? null}
          rootImagePath={store.project.rootImage ?? null}
          initialJob={sdGenerate.context?.regenerateJob ?? null}
          onClose={sdGenerate.close}
        />,
      )}

      {saveAsProgress && <SaveProgressModal data={saveAsProgress} title="Enregistrement sous..." doneTitle="Copie terminée" />}
      {saveProgress && <SaveProgressModal data={saveProgress} title="Enregistrement..." doneTitle="Projet enregistré" />}
      {triageRequest && (
        <SessionMediaTriageModal items={triageRequest.items} onResolve={triageRequest.resolve} />
      )}
      {showMissingMediaRelink && renderDeferred(
        <MissingMediaRelinkModal
          missingMedia={missingMedia}
          workspaceDir={workspaceDir}
          onApply={handleApplyMissingMediaRelinks}
          onClose={() => setDismissedMissingMediaSignature(missingMediaSignature)}
        />,
      )}

      {unpacking && (
        <GenerateProgressModal title="Extraction en cours...">
          <div className="gen-progress-name">{unpacking.name}</div>
          <div className="gen-progress-desc">
            Story Studio analyse le pack et extrait les éléments éditables.
          </div>
        </GenerateProgressModal>
      )}

      {importing && (
        <GenerateProgressModal title="Import en cours...">
          <div className="gen-progress-name">{importing.name}</div>
          <div className="gen-progress-desc">{importing.phase}</div>
          <div className="gen-progress-meta">
            {importing.total > 1 ? `Fichier ${Math.max(importing.index, 1)} sur ${importing.total}` : 'Traitement du fichier importé'}
          </div>
        </GenerateProgressModal>
      )}

      {importNotice && (
        <ImportNoticeToast message={importNotice} onClose={() => setImportNotice(null)} />
      )}

      {/* Bottom bar */}
      <div className="bottombar">
        <span className="status-text">{statusText}</span>
        {projectType !== null && !bottomPanelOpen && (
          <button
            className="rq-bottombar-btn"
            onClick={() => {
              setBottomPanelTab('media');
              setBottomPanelOpen(true);
            }}
          >
            Médias
            <span>({mediaLibraryCount})</span>
          </button>
        )}
        {projectType !== null && !bottomPanelOpen && (
          <button
            className={`rq-bottombar-btn${renderQueue.activeCount > 0 ? ' has-active' : ''}`}
            onClick={() => {
              setBottomPanelTab('queue');
              setBottomPanelOpen(true);
            }}
          >
            {renderQueue.activeCount > 0 && <span className="rq-spinner" />}
            File de rendu
            {renderQueue.activeCount > 0 && <span className="bottom-status-pill">{renderQueue.activeCount}</span>}
            {renderQueue.activeCount === 0 && renderQueue.hasResults && <span className="bottom-status-pill is-done">✓</span>}
          </button>
        )}
        {projectType !== null && !bottomPanelOpen && (
          <button
            className={`rq-bottombar-btn${aiQueueActiveCount > 0 ? ' has-active' : ''}`}
            onClick={() => {
              setBottomPanelTab('ai');
              setBottomPanelOpen(true);
            }}
          >
            {aiQueueActiveCount > 0 && <span className="rq-spinner" />}
            File IA
            {aiQueueActiveCount > 0 && <span className="bottom-status-pill">{aiQueueActiveCount}</span>}
            {aiQueueActiveCount === 0 && aiQueueHasResults && <span className="bottom-status-pill is-done">✓</span>}
          </button>
        )}
        {appVersion && <span className="bottombar-version">v{appVersion}</span>}
      </div>

      {/* Credits modal */}
      {creditsOpen && (
        <CreditsModal appVersion={appVersion} onClose={() => setCreditsOpen(false)} />
      )}
    </div>
    </ProjectActionsContext.Provider>
    </ProjectContext.Provider>
    </MediaTransferProvider>
  );
}

export default function App() {
  return (
    <ErrorDialogProvider>
      <AppContent />
    </ErrorDialogProvider>
  );
}
