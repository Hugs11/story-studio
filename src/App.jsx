import { Suspense, lazy, useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openPath } from '@tauri-apps/plugin-opener';
import { sanitizeImportedName, useProjectStore } from './store/projectStore';
import {
  getRecentProjects,
  rememberRecentProject,
  ensureExportsDir,
  pickWorkspaceDir,
  getWorkspaceDir,
  consolidateProject,
  projectToRustExport,
} from './store/projectIO';
import { getLastExportDir, saveLastExportDir } from './hooks/useFileDialog';
import { ProjectContext } from './store/ProjectContext';
import { MediaTransferProvider } from './store/MediaTransferContext';
import { getGenerateErrors } from './store/projectValidation';
import { collectMediaLibrary } from './store/mediaLibrary';
import {
  buildRelinkSignature,
  collectMissingMedia,
  relinkMediaLibraryPaths,
  relinkMediaTags,
  relinkProjectMedia,
} from './store/missingMediaRelink';
import { buildProjectIndex, collectProjectAudioPaths } from './store/projectModel';
import {
  hasExplicitExportPackName,
  isProjectDirty,
} from './store/projectHelpers';
import { KEYS, read as readSetting } from './store/persistentSettings';
import { loadXttsSettings, saveXttsSettings } from './store/xttsSettings';
import { useSdStore } from './store/sdStore';
import { useXttsStore } from './store/xttsStore';
import { useRenderQueueStore } from './store/renderQueueStore';
import { getImageJobTargetLabel } from './store/aiJobLabels';
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
import { Loader2, TriangleAlert } from './components/icons/LucideLocal';
import { AppModalPortal } from './components/common/AppModalPortal';
import { SaveProgressModal } from './components/common/SaveProgressModal';
import { TitleBar } from './components/layout/TitleBar';
import { Toolbar } from './components/layout/Toolbar';
import { PanelRail } from './components/layout/PanelRail';
import { BottomWorkspacePanel } from './components/BottomWorkspacePanel/BottomWorkspacePanel';
import { ErrorDialogProvider, useErrorDialog } from './components/common/Dialog';
import { useEscapeKey } from './hooks/useEscapeKey';
import { useAiJobUsage } from './hooks/useAiJobUsage';
import { useAppShortcuts } from './hooks/useAppShortcuts';
import { useAutosave } from './hooks/useAutosave';
import { useImportSession } from './hooks/useImportSession';
import { useMediaLibraryPaths } from './hooks/useMediaLibraryPaths';
import { useMediaTransferHandlers } from './hooks/useMediaTransferHandlers';
import { useOsFileDrop } from './hooks/useOsFileDrop';
import { usePersistentState } from './hooks/usePersistentState';
import { useProjectLoading } from './hooks/useProjectLoading';
import { useSaveProgress } from './hooks/useSaveProgress';
import { useSyncedRef } from './hooks/useSyncedRef';
import { useWindowCloseGuard } from './hooks/useWindowCloseGuard';
import { useSDJobs } from './hooks/useSDJobs';
import { useXttsJobs } from './hooks/useXttsJobs';
import { logger, installGlobalErrorHandlers, setLogLevel } from './utils/logger';
import { loadVerboseLoggingPref, saveVerboseLoggingPref, verboseLevelName } from './store/loggingPreference';
import { isTauriRuntime } from './utils/tauriRuntime';
import { getExportPackName } from './utils/packConvention';
import { getProjectFilePrefix } from './utils/projectPrefix';
import { basename } from './utils/fileUtils';
import './styles/variables.css';
import './styles/layout.css';
import './components/layout/AppChrome.css';
import './components/RenderQueuePanel/RenderQueuePanel.css';
import './components/GenerateModal/GenerateModal.css';

const EditorTab = lazy(() => import('./tabs/EditorTab').then((module) => ({ default: module.EditorTab })));
const DiagramTab = lazy(() => import('./tabs/DiagramTab').then((module) => ({ default: module.DiagramTab })));
const OptionsTab = lazy(() => import('./tabs/OptionsTab').then((module) => ({ default: module.OptionsTab })));
const EmulatorTab = lazy(() => import('./tabs/EmulatorTab').then((module) => ({ default: module.EmulatorTab })));
const SDGenerateModal = lazy(() => import('./components/SDGenerateModal/SDGenerateModal').then((module) => ({ default: module.SDGenerateModal })));
const RecordModal = lazy(() => import('./components/RecordModal/RecordModal').then((module) => ({ default: module.RecordModal })));
const PackNameModal = lazy(() => import('./components/layout/PackNameModal').then((module) => ({ default: module.PackNameModal })));
const MissingMediaRelinkModal = lazy(() => import('./components/MissingMediaRelink/MissingMediaRelinkModal')
  .then((module) => ({ default: module.MissingMediaRelinkModal })));

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

function isImportedPackPath(filePath) {
  return /\.(zip|7z)$/i.test(filePath || '');
}

function getImportDisplayName(filePath) {
  const fileName = basename(filePath);
  return sanitizeImportedName(fileName, fileName || 'Import en cours');
}

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
    title: 'Projet non sauvegardé',
    message: 'Voulez-vous sauvegarder le projet avant de continuer ?',
    variant: 'warning',
    cancelValue: 'cancel',
    actions: [
      { value: 'cancel', label: 'Annuler', autoFocus: true },
      { value: 'discard', label: 'Ne pas sauvegarder' },
      { value: 'save', label: 'Sauvegarder', kind: 'primary' },
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
  const [autoSavedPath, setAutoSavedPath] = useState(null); // path of last autosave (display only)
  const [appVersion, setAppVersion] = useState('');
  const [pendingZipPath, setPendingZipPath] = useState(null); // ZIP à simuler depuis l'éditeur
  const [xttsSettings, setXttsSettings] = useState(() => loadXttsSettings());
  const [keyboardShortcuts, setKeyboardShortcuts] = useState(() => loadKeyboardShortcuts());
  const [themePreference, setThemePreference] = useState(() => loadThemePreference());
  const [recentProjects, setRecentProjects] = useState(() => getRecentProjects());
  const sdStore = useSdStore();
  const xttsStore = useXttsStore();
  useRenderQueueExecutor({ jobs: renderQueue.jobs, updateJob: renderQueue.updateJob, appendLog: renderQueue.appendLog });
  const [sdGenerateOpen, setSdGenerateOpen] = useState(false);
  const [sdGenerateContext, setSdGenerateContext] = useState(null);
  const [bottomPanelOpen, setBottomPanelOpen] = usePersistentState(KEYS.BOTTOM_PANEL_OPEN, false, BOOL_CODEC);
  const [bottomPanelTab, setBottomPanelTab] = usePersistentState(KEYS.BOTTOM_PANEL_TAB, 'media');
  const [creditsOpen, setCreditsOpen] = useState(false);
  const [packOptionsOpen, setPackOptionsOpen] = useState(false);
  const [packMetadataOpen, setPackMetadataOpen] = useState(false);
  const [toolbarRecordOpen, setToolbarRecordOpen] = useState(false);
  const [copyImportedFilesEnabled, setCopyImportedFilesEnabled] = usePersistentState(KEYS.COPY_FILES, false, BOOL_CODEC);
  const [workspaceDir, setWorkspaceDirState] = useState(() => readSetting(KEYS.WORKSPACE_DIR, { defaultValue: '' }));
  const [importNotice, setImportNotice] = useState(null); // string | null
  const [activeDropZone, setActiveDropZone] = useState(null);
  const [autoSaveEnabled, setAutoSaveEnabled] = usePersistentState(KEYS.AUTOSAVE_ENABLED, false, BOOL_CODEC);
  const [autoSaveBackupLimit, setAutoSaveBackupLimit] = usePersistentState(KEYS.AUTOSAVE_BACKUP_LIMIT, 5, INT_CODEC);
  const [showCentralDiagram, setShowCentralDiagram] = usePersistentState(KEYS.SHOW_CENTRAL_DIAGRAM, false, BOOL_CODEC);
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
  const [diagramInspectRequest, setDiagramInspectRequest] = useState(null);
  const [dismissedMissingMediaSignature, setDismissedMissingMediaSignature] = useState('');
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

  useEffect(() => {
    let cancelled = false;
    getWorkspaceDir().then((dir) => {
      if (!cancelled) setWorkspaceDirState(dir);
    }).catch(() => {});
    return () => { cancelled = true; };
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

  const askSaveBeforeLeaveCurrent = useCallback((project, savedSnapshot, onSave) => (
    askSaveBeforeLeave(project, savedSnapshot, onSave, showChoiceDialog)
  ), [showChoiceDialog]);

  useWindowCloseGuard({
    askSaveBeforeLeave: askSaveBeforeLeaveCurrent,
    projectRef,
    savedSnapshotRef,
    saveHandlerRef,
  });

  useEffect(() => {
    if (!copyImportedFilesEnabled) dismissedTransferPromptRef.current = null;
  }, [copyImportedFilesEnabled]);

  useEffect(() => {
    setDismissedMissingMediaSignature('');
  }, [store.savePath]);

  useEffect(() => {
    if (renderQueue.panelOpen) {
      setBottomPanelOpen(true);
      setBottomPanelTab('queue');
      renderQueue.setPanelOpen(false);
    }
  }, [renderQueue.panelOpen, renderQueue.setPanelOpen]);

  useAppShortcuts({ actionsRef: shortcutActionsRef, keyboardShortcutsRef, saveHandlerRef, saveAsHandlerRef });

  // mediaLibraryPathsRef est consomme par useAutosave juste apres ; sa declaration
  // doit donc preceder. (Bug TDZ latent dans le code historique, declenche par
  // certains modes de build/runtime.)
  const {
    mediaLibraryPaths,
    mediaLibraryPathsRef,
    setMediaLibraryPaths,
    addPathsToMediaLibrary,
    handleMediaCreated,
    handleDeleteMedia,
  } = useMediaLibraryPaths({ store, sdStore, xttsStore, workspaceDirRef });

  useAutosave({
    enabled: autoSaveEnabled,
    backupLimit: autoSaveBackupLimit,
    projectRef,
    savedSnapshotRef,
    savePathRef,
    workspaceDirRef,
    autoSavePathRef,
    isSavingRef,
    mediaTagsRef,
    mediaLibraryPathsRef,
    mediaLibraryCountRef,
    setAutoSavedPath,
    setSaveToast,
    saveHandlerRef,
  });

  useEscapeKey(creditsOpen, () => setCreditsOpen(false));

  useSDJobs(sdStore, workspaceDir, handleMediaCreated);
  useXttsJobs(xttsStore, applyGeneratedAudioToTarget, workspaceDir, handleMediaCreated);

  function handleOpenAiQueue() {
    setBottomPanelTab('ai');
    setBottomPanelOpen(true);
  }

  function handleOpenSDGenerate(context = null) {
    setSdGenerateContext(context);
    setSdGenerateOpen(true);
  }

  function handleRegenerateImageJob(job) {
    if (!job) return;
    setSdGenerateContext({ regenerateJob: job });
    setSdGenerateOpen(true);
  }

  function handleSDGenerate(workflowId, workflowName, params) {
    sdStore.addJob(workflowId, workflowName, params, {
      projectName: getProjectFilePrefix(store.project, store.savePath),
      fieldId: sdGenerateContext?.fieldId || null,
      targetLabel: getImageJobTargetLabel(sdGenerateContext, projectIndex),
    });
    handleOpenAiQueue();
  }

  function applyGeneratedAudioToTarget(target, path) {
    if (!target || !path) return;
    switch (target.kind) {
      case 'root':
        store.updateRootMedia(target.field, path);
        return;
      case 'rootStory':
        store.updateStoryAudio(path);
        return;
      case 'menu':
        store.updateMenu(target.entryId, { [target.field]: path });
        return;
      case 'story':
        store.updateItem(target.entryId, { [target.field]: path });
        return;
      case 'storySequence': {
        const entry = projectIndex.entryById.get(target.entryId);
        if (!entry?.afterPlaybackSequence?.length) return;
        store.updateItem(target.entryId, {
          afterPlaybackSequence: entry.afterPlaybackSequence.map((step) => (
            step.id === target.stepId ? { ...step, [target.field]: path } : step
          )),
        });
        return;
      }
      case 'storyHomeStep': {
        const entry = projectIndex.entryById.get(target.entryId);
        if (!entry?.afterPlaybackHomeStep) return;
        store.updateItem(target.entryId, {
          afterPlaybackHomeStep: { ...entry.afterPlaybackHomeStep, [target.field]: path },
        });
        return;
      }
      default:
        return;
    }
  }

  const { getAudioJobUsage, getImageJobUsage } = useAiJobUsage({ project: store.project, projectIndex });

  async function handleQueueXttsGenerate(job) {
    xttsStore.addJob({
      label: job.targetLabel || 'Audio IA',
      targetLabel: job.targetLabel || 'Audio IA',
      voiceLabel: job.voiceLabel || 'XTTS',
      target: job.target || null,
      request: job.request,
      settings: { ...xttsSettings },
      projectName: getProjectFilePrefix(store.project, store.savePath),
    });
    handleOpenAiQueue();
  }

  async function handleNewProject() {
    const canContinue = await askSaveBeforeLeaveCurrent(store.project, savedSnapshotRef.current, handleSaveProject);
    if (!canContinue) return;
    store.resetProject();
    setMediaLibraryPaths([]);
    savedSnapshotRef.current = null;
    autoSavePathRef.current = null;
    setAutoSavedPath(null);
    sdStore.clearDone();
    xttsStore.clearDone();
  }

  async function resolveDefaultExportDir() {
    let defaultPath = getLastExportDir();
    if (!defaultPath) {
      const ws = workspaceDirRef.current || readSetting(KEYS.WORKSPACE_DIR, { defaultValue: '' });
      if (ws) {
        const exportsDir = await ensureExportsDir(ws);
        if (exportsDir) defaultPath = exportsDir;
      }
    }
    return defaultPath;
  }

  async function handleGenerate(projectOverride = null) {
    const projectForGeneration = projectOverride && !projectOverride?.preventDefault
      ? projectOverride
      : store.project;
    if ((projectForGeneration.projectType === 'pack' || projectForGeneration.projectType === 'simple')
      && !hasExplicitExportPackName(projectForGeneration)) {
      setPackMetadataOpen(true);
      return;
    }
    if (pathAuditPending) {
      showErrorDialog({
        title: 'Vérification en cours',
        message: 'Vérification des fichiers du projet en cours. Attendez une seconde puis réessayez.',
        variant: 'warning',
      });
      return;
    }
    const validationErrors = getGenerateErrors(projectForGeneration, pathAudit);
    if (validationErrors.length > 0) {
      logger.warn(`generate:blocked count=${validationErrors.length}`);
      showErrorDialog({
        title: 'Impossible de générer',
        message: `Impossible de générer le pack :\n\n• ${validationErrors.join('\n• ')}`,
      });
      return;
    }
    const defaultPath = await resolveDefaultExportDir();
    const outputFolder = await openDialog({ directory: true, multiple: false, title: 'Dossier de sortie du pack', defaultPath });
    if (!outputFolder) return;
    saveLastExportDir(outputFolder);
    logger.info(`generate:queued projectType=${projectForGeneration.projectType} name='${projectForGeneration.projectName}' outputFolder='${outputFolder}'`);
    renderQueue.addJob({
      projectName: projectForGeneration.projectName || '(sans nom)',
      savePath: store.savePath ?? null,
      projectJson: JSON.stringify(projectToRustExport(projectForGeneration)),
      outputFolder,
    });
  }

  async function handleOpenExportFolder() {
    const dir = getLastExportDir() || await resolveDefaultExportDir();
    if (!dir) {
      showErrorDialog({
        title: 'Dossier d’export',
        message: "Aucun dossier d'export connu pour le moment.",
        variant: 'info',
      });
      return;
    }
    try {
      await openPath(dir);
    } catch (error) {
      showErrorDialog({
        title: 'Dossier d’export',
        message: `Impossible d'ouvrir le dossier d'export : ${error}`,
      });
    }
  }

  async function handleSavePackMetadata(draft, { generate = false } = {}) {
    const nextPackMetadata = { ...(store.project.packMetadata ?? {}), ...draft };
    const isSimple = store.project.projectType === 'simple';
    const nextTitle = String(draft?.title ?? '').trim();
    const projectForAction = {
      ...store.project,
      packMetadata: nextPackMetadata,
      ...(isSimple && nextTitle ? { projectName: nextTitle } : {}),
    };
    if (!generate) {
      store.setProject(projectForAction);
      setPackMetadataOpen(false);
      return;
    }
    const result = await handleSaveProject({
      projectOverride: projectForAction,
      returnResult: true,
    });
    if (!result?.project) return;
    setPackMetadataOpen(false);
    if (generate) await handleGenerate(result.project);
  }

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

  function handleSimulateZip(zipPath) {
    setPendingZipPath(zipPath);
    store.setActiveTab('emu');
  }

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
      setWorkspaceDirState(chosen);
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

  const [importing, setImporting] = useState(null);
  const [unpacking, setUnpacking] = useState(null);

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
    isSavingRef,
    setSaveToast,
    setRecentProjects,
    maybeOfferTransferIntoProject,
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
    handleSaveProject,
    showErrorDialog,
    isProjectDirty,
    showChoiceDialog,
  });

  const handleApplyMissingMediaRelinks = useCallback(async (replacements, { saveAfter = false } = {}) => {
    const nextProject = relinkProjectMedia(store.project, replacements);
    const nextMediaTags = relinkMediaTags(store.mediaTags, replacements);
    const nextMediaLibraryPaths = relinkMediaLibraryPaths(mediaLibraryPathsRef.current, replacements);
    store.setProject(nextProject);
    store.setMediaTags(nextMediaTags);
    setMediaLibraryPaths(nextMediaLibraryPaths);
    mediaLibraryPathsRef.current = nextMediaLibraryPaths;
    setDismissedMissingMediaSignature(buildRelinkSignature(collectMissingMedia(nextProject, pathAudit)));
    if (saveAfter) {
      await handleSaveProject({
        projectOverride: nextProject,
        mediaTagsOverride: nextMediaTags,
        mediaLibraryPathsOverride: nextMediaLibraryPaths,
      });
    }
  }, [
    handleSaveProject,
    mediaLibraryPathsRef,
    pathAudit,
    setMediaLibraryPaths,
    store,
  ]);

  const {
    dispatchFiles,
    handleAddStory,
    handleAddStoryToMenu,
    handleImportFolder,
    handleUnpackZip,
    handleImportMediaLibrary,
    handleImportMediaLibraryFolder,
  } = useImportSession({
    store,
    projectIndex,
    maybeCopyToProject,
    copyGeneratedMediaToProject,
    extractAudioEmbeddedImage,
    setImporting,
    setUnpacking,
    setImportNotice,
    addPathsToMediaLibrary,
    persistProjectSnapshot,
    workspaceDirRef,
    handleSaveProject,
    showErrorDialog,
    getImportDisplayName,
    isImportedPackPath,
  });

  useOsFileDrop({
    dispatchFiles,
    maybeCopyToProject,
    copyGeneratedMediaToProject,
    extractAudioEmbeddedImage,
    addPathsToMediaLibrary,
    setImporting,
    setActiveDropZone,
    getImportDisplayName,
  });

  useSyncedRef(saveHandlerRef, handleSaveProject);
  useSyncedRef(saveAsHandlerRef, handleSaveProjectAs);

  function hasWebmFiles(project) {
    const allAudio = collectProjectAudioPaths(project);
    return allAudio.some(f => f && f.toLowerCase().endsWith('.webm'));
  }

  async function handleUpdateGlobalOption(key, value) {
    if (key === 'convertFormat' && !value && hasWebmFiles(store.project)) {
      const confirmed = await showConfirmDialog({
        title: 'Fichiers .webm détectés',
        message:
          "Un ou plusieurs fichiers audio sont au format .webm, qui n'est pas compatible avec la Boîte à Histoires.\n\n"
          + "Désactiver « Convertir au bon format » risque de produire un pack non fonctionnel.",
        variant: 'warning',
        okLabel: 'Désactiver quand même',
        cancelLabel: 'Garder activé',
      });
      if (!confirmed) return;
    }
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

  const allStories = useMemo(
    () => projectIndex.flatEntries
      .filter((e) => e.type === 'story' || e.type === 'zip')
      .map((e) => ({ id: e.id, name: e.entry.name, type: e.type })),
    [projectIndex],
  );

  const { projectType } = store.project;
  const missingMedia = useMemo(
    () => collectMissingMedia(store.project, pathAudit),
    [store.project, pathAudit],
  );
  const missingMediaSignature = useMemo(
    () => buildRelinkSignature(missingMedia),
    [missingMedia],
  );
  const showMissingMediaRelink = projectType !== null
    && !!store.savePath
    && !pathAuditPending
    && missingMedia.length > 0
    && missingMediaSignature !== dismissedMissingMediaSignature;
  const errors = validationIssues.filter((issue) => issue.status === 'error').length;
  const warnings = validationIssues.filter((issue) => issue.status === 'warning').length;
  const totalIssues = errors + warnings;

  const statusText = projectType === null ? 'Choisissez un type de projet' : '';
  const projectDirty = savedSnapshotRef.current === null
    ? isProjectDirty(store.project)
    : JSON.stringify(store.project) !== savedSnapshotRef.current;
  const titleBarName = store.project.projectName?.trim() || null;
  const canImportStories = (store.activeTab === 'edit' || store.activeTab === 'diagram') && store.project.projectType === 'pack';
  const canAddFolder = canImportStories;
  const canRecord = canImportStories;
  const shortcutLabels = useMemo(() => getShortcutLabelMap(keyboardShortcuts), [keyboardShortcuts]);
  const effectiveProjectFilePrefix = getProjectFilePrefix(store.project, store.savePath);
  const exportPackName = getExportPackName(store.project.packMetadata);
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

  function handleToolbarRecordSaved(path) {
    const selId = store.selectedId;
    const entry = selId && selId !== 'root' ? projectIndex.entryById.get(selId) : null;
    const menuId = !entry ? null
      : entry.type === 'menu' ? selId
      : (projectIndex.parentMenuById.get(selId) ?? null);
    store.addStory(menuId, path);
    setToolbarRecordOpen(false);
  }
  const canGenerate = projectType !== null && !pathAuditPending && totalIssues === 0;

  useSyncedRef(shortcutActionsRef, {
    newProject: handleNewProject,
    openProject: handleLoad,
    importStories: handleAddStory,
    addFolder: () => store.addMenu(),
    openPackOptions: () => setPackOptionsOpen(true),
    setActiveTab: store.setActiveTab,
    generate: handleGenerate,
    focusTreeSearch: () => setTreeSearchFocusTrigger((n) => n + 1),
    toggleValidation: () => setValidationOpen((open) => !open),
    undo: store.undo,
    redo: store.redo,
    projectActionsVisible: projectType !== null,
    activeTab: store.activeTab,
    canImportStories,
    canAddFolder,
    canGenerate,
    canUndo: store.canUndo,
    canRedo: store.canRedo,
    hasValidationErrors: totalIssues > 0,
  });

  const optionsTabProps = {
    copyFilesEnabled: copyImportedFilesEnabled,
    onCopyFilesChange: handleCopyImportedFilesChange,
    workspaceDir,
    onPickWorkspaceDir: handlePickWorkspaceDir,
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
    showCentralDiagram,
    onShowCentralDiagramChange: setShowCentralDiagram,
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
      onEnableConvert: () => store.updateGlobalOption('convertFormat', true),
      onImportFile: maybeCopyToProject,
      onExtractAudioEmbeddedImage: extractAudioEmbeddedImage,
      onSave: handleSaveProject,
      onOpenSDGenerate: handleOpenSDGenerate,
      onRemoveSdResult: sdStore.removeResult,
      onQueueXttsGenerate: handleQueueXttsGenerate,
      onMediaCreated: handleMediaCreated,
    }}>
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
        hasSavePath={!!(store.savePath || autoSavedPath)}
        saveState={saveToast}
        showProjectMeta={projectType !== null}
        onOpenPackMetadata={projectType !== null ? () => setPackMetadataOpen(true) : null}
        onOpenCredits={() => setCreditsOpen(true)}
      />

      {projectType !== null && (
        <Toolbar
          showProjectActions={projectType !== null}
          shortcutLabels={shortcutLabels}
          canImportStories={canImportStories}
          canImportFolder={canImportStories}
          canAddFolder={canAddFolder}
          saveState={saveToast}
          generateDisabled={!canGenerate}
          onNewProject={handleNewProject}
          onOpenProject={handleLoad}
          onSaveProject={handleSave}
          onSaveProjectAs={handleSaveProjectAs}
          onImportStories={() => handleAddStory()}
          onImportFolder={() => handleImportFolder()}
          onAddFolder={() => store.addMenu()}
          onRecord={handleToolbarRecord}
          canRecord={canRecord}
          packOptionsOpen={packOptionsOpen}
          onPackOptionsOpenChange={setPackOptionsOpen}
          projectType={store.project.projectType}
          globalOptions={store.project.globalOptions}
          onUpdateGlobalOption={handleUpdateGlobalOption}
          onGenerate={handleGenerate}
          onOpenPackMetadata={projectType !== null ? () => setPackMetadataOpen(true) : null}
          onOpenExportFolder={handleOpenExportFolder}
          exportPackName={exportPackName}
          generateShortcut={shortcutLabels.generate}
          validationIssues={validationIssues}
          pathAuditPending={pathAuditPending}
          validationOpen={validationOpen}
          onValidationOpenChange={setValidationOpen}
          onSelectIssue={(id) => {
            if (!id) return;
            store.setSelectedId(id);
            if (store.activeTab === 'diagram') {
              setDiagramInspectRequest({ id, nonce: Date.now() });
              return;
            }
            store.setActiveTab('edit');
          }}
        />
      )}

      <div className="chrome-shell">
        {projectType !== null ? (
          <PanelRail activeTab={store.activeTab} onChange={store.setActiveTab} shortcutLabels={shortcutLabels} />
        ) : null}

        <div className="chrome-content">
          {store.activeTab === 'edit' && renderDeferred(
            <EditorTab
              project={store.project}
              node={selectedNode}
              selectedId={store.selectedId}
              onSelect={store.setSelectedId}
              onReorder={handleReorder}
              onMoveToMenu={store.moveItemToMenu}
              onAddMenu={handleAddMenu}
              onAddStory={handleAddStory}
              onUpdateRoot={handleUpdateRoot}
              onUpdateMedia={store.updateRootMedia}
              onUpdateStoryAudio={store.updateStoryAudio}
              onSetProjectType={store.setProjectType}
              onOpenProject={handleLoad}
              onOpenPreferences={() => projectType === null ? setPrefsModalOpen(true) : store.setActiveTab('opts')}
              recentProjects={recentProjects}
              onOpenRecentProject={handleLoadRecent}
              savePath={store.savePath}
              onUpdateMenu={handleUpdateMenu}
              onDeleteMenu={handleDeleteMenu}
              onSetMenuAsRoot={handleSetMenuAsRoot}
              onDemoteRootToMenu={handleDemoteRootToMenu}
              onUpdateItem={handleUpdateItem}
              onDeleteItem={handleDeleteItem}
              onBulkUpdateItems={handleBulkUpdateItems}
              onBulkDeleteItems={handleBulkDeleteItems}
              onAddStoryToMenu={handleAddStoryToMenu}
              onImportFolder={handleImportFolder}
              onUnpackZip={handleUnpackZip}
              onSimulateZip={handleSimulateZip}
              onPasteEntries={store.pasteEntriesToMenu}
              onCutPasteEntries={store.cutPasteEntriesToMenu}
              onDuplicate={store.duplicateEntry}
              onAddEndNode={handleAddEndNode}
              onRemoveEndNode={handleRemoveEndNode}
              onUpdateNightModeAudio={(value) => store.updateRootMedia('nightModeAudio', value)}
              onUpdateNightMode={(value) => store.updateGlobalOption('nightMode', value)}
              onUpdateNightModeReturn={(value) => store.updateRootMedia('nightModeReturn', value)}
              onUpdateNightModeHomeReturn={(value) => store.updateRootMedia('nightModeHomeReturn', value)}
              pathAudit={pathAudit}
              validationIssues={validationIssues}
              allMenus={allMenus}
              projectIndex={projectIndex}
              treeSearchFocusTrigger={treeSearchFocusTrigger}
              showCentralDiagram={showCentralDiagram}
            />,
          )}
          {store.activeTab === 'diagram' && renderDeferred(
            <DiagramTab
              project={store.project}
              projectType={projectType}
              projectIndex={projectIndex}
              allMenus={allMenus}
              allStories={allStories}
              selectedId={store.selectedId}
              inspectRequest={diagramInspectRequest}
              onSelect={store.setSelectedId}
              onMoveToMenu={store.moveItemToMenu}
              onImportStories={() => handleAddStory()}
              onUpdateRoot={handleUpdateRoot}
              onUpdateMedia={store.updateRootMedia}
              onUpdateStoryAudio={store.updateStoryAudio}
              onUpdateMenu={handleUpdateMenu}
              onDeleteMenu={handleDeleteMenu}
              onUpdateItem={handleUpdateItem}
              onDeleteItem={handleDeleteItem}
              onAddMenu={handleAddMenu}
              onAddStory={handleAddStoryToMenu}
              onUnpackZip={handleUnpackZip}
              onSimulateZip={handleSimulateZip}
              onSetMenuAsRoot={handleSetMenuAsRoot}
              onDemoteRootToMenu={handleDemoteRootToMenu}
              onBulkUpdateItems={handleBulkUpdateItems}
              onBulkDeleteItems={handleBulkDeleteItems}
              onPasteEntries={store.pasteEntriesToMenu}
              onCutPasteEntries={store.cutPasteEntriesToMenu}
              onDuplicate={store.duplicateEntry}
              onAddEndNode={handleAddEndNode}
              onRemoveEndNode={handleRemoveEndNode}
              onUpdateNightModeAudio={(value) => store.updateRootMedia('nightModeAudio', value)}
              onUpdateNightMode={(value) => store.updateGlobalOption('nightMode', value)}
              onUpdateNightModeReturn={(value) => store.updateRootMedia('nightModeReturn', value)}
              onUpdateNightModeHomeReturn={(value) => store.updateRootMedia('nightModeHomeReturn', value)}
            />,
          )}
          {store.activeTab === 'emu' && renderDeferred(
            <EmulatorTab project={store.project} initialZipPath={pendingZipPath} onConsumeZipPath={() => setPendingZipPath(null)} />,
          )}
          {store.activeTab === 'opts' && renderDeferred(
            <OptionsTab
              {...optionsTabProps}
              onBackToHome={projectType === null ? () => store.setActiveTab('edit') : null}
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
              onSelectNode={(id) => { store.setActiveTab('edit'); store.setSelectedId(id); }}
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
          onClose={() => setToolbarRecordOpen(false)}
        />
      )}

      {packMetadataOpen && renderDeferred(
        <PackNameModal
          open={packMetadataOpen}
          packMetadata={projectType === 'simple'
            ? {
                ...(store.project.packMetadata ?? {}),
                title: store.project.packMetadata?.title || store.project.projectName || '',
              }
            : store.project.packMetadata}
          project={store.project}
          coverImage={store.project.thumbnailImage || store.project.rootImage}
          exportFolder={modalExportFolder}
          generateDisabled={!canGenerate}
          onSave={(draft) => handleSavePackMetadata(draft, { generate: false })}
          onSaveAndGenerate={(draft) => handleSavePackMetadata(draft, { generate: true })}
          onClose={() => setPackMetadataOpen(false)}
        />,
      )}

      {/* SD — modale de génération */}
      {sdGenerateOpen && renderDeferred(
        <SDGenerateModal
          sdSettings={sdStore.sdSettings}
          onGenerate={handleSDGenerate}
          currentImagePath={sdGenerateContext?.currentImagePath ?? null}
          currentImageLabel={sdGenerateContext?.currentImageLabel ?? null}
          rootImagePath={store.project.rootImage ?? null}
          initialJob={sdGenerateContext?.regenerateJob ?? null}
          onClose={() => {
            setSdGenerateOpen(false);
            setSdGenerateContext(null);
          }}
        />,
      )}

      {saveAsProgress && <SaveProgressModal data={saveAsProgress} title="Enregistrement sous..." doneTitle="Copie terminée" />}
      {saveProgress && <SaveProgressModal data={saveProgress} title="Enregistrement..." doneTitle="Projet enregistré" />}
      {showMissingMediaRelink && renderDeferred(
        <MissingMediaRelinkModal
          missingMedia={missingMedia}
          workspaceDir={workspaceDir}
          onApply={handleApplyMissingMediaRelinks}
          onClose={() => setDismissedMissingMediaSignature(missingMediaSignature)}
        />,
      )}

      {unpacking && (
        <AppModalPortal className="gen-overlay">
          <div className="gen-modal" style={{ width: 420, maxWidth: '92vw' }}>
            <div className="gen-header">
              <span className="gen-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <Loader2 style={{ width: 16, height: 16, animation: 'spin 1s linear infinite' }} />
                Extraction en cours...
              </span>
            </div>
            <div style={{ padding: '22px 20px', display: 'flex', alignItems: 'center', gap: 14 }}>
              <div className="gen-spinner" style={{ flexShrink: 0 }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontSize: 13, color: 'var(--color-text-primary)', fontWeight: 600 }}>
                  {unpacking.name}
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
                  Story Studio analyse le pack et extrait les éléments éditables.
                </div>
              </div>
            </div>
          </div>
        </AppModalPortal>
      )}

      {importing && (
        <AppModalPortal className="gen-overlay">
          <div className="gen-modal" style={{ width: 420, maxWidth: '92vw' }}>
            <div className="gen-header">
              <span className="gen-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <Loader2 style={{ width: 16, height: 16, animation: 'spin 1s linear infinite' }} />
                Import en cours...
              </span>
            </div>
            <div style={{ padding: '22px 20px', display: 'flex', alignItems: 'center', gap: 14 }}>
              <div className="gen-spinner" style={{ flexShrink: 0 }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: 'var(--color-text-primary)', fontWeight: 600 }}>
                  {importing.name}
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
                  {importing.phase}
                </div>
                <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                  {importing.total > 1 ? `Fichier ${Math.max(importing.index, 1)} sur ${importing.total}` : 'Traitement du fichier importé'}
                </div>
              </div>
            </div>
          </div>
        </AppModalPortal>
      )}

      {importNotice && (
        <div style={{
          position: 'fixed', bottom: 32, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--color-warning-bg, #3a2e00)', border: '1px solid var(--color-warning-border, #a07800)',
          color: 'var(--color-warning-text, #f5d060)', borderRadius: 8, padding: '10px 14px',
          display: 'flex', alignItems: 'flex-start', gap: 10, maxWidth: 540, zIndex: 9999,
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)', fontSize: 12, lineHeight: 1.5,
        }}>
          <span style={{ flex: 1, display: 'inline-flex', alignItems: 'flex-start', gap: 8 }}>
            <TriangleAlert style={{ width: 16, height: 16, flexShrink: 0, marginTop: 1 }} />
            <span>{importNotice}</span>
          </span>
          <button
            onClick={() => setImportNotice(null)}
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: '0 2px', fontSize: 14, lineHeight: 1, flexShrink: 0 }}
            title="Fermer"
          >✕</button>
        </div>
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
            {renderQueue.activeCount > 0 && <span className="rq-spinner" style={{ borderColor: 'currentColor', borderTopColor: 'transparent' }} />}
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
            {aiQueueActiveCount > 0 && <span className="rq-spinner" style={{ borderColor: 'currentColor', borderTopColor: 'transparent' }} />}
            File IA
            {aiQueueActiveCount > 0 && <span className="bottom-status-pill">{aiQueueActiveCount}</span>}
            {aiQueueActiveCount === 0 && aiQueueHasResults && <span className="bottom-status-pill is-done">✓</span>}
          </button>
        )}
        {appVersion && <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>v{appVersion}</span>}
      </div>

      {/* Credits modal */}
      {creditsOpen && (
        <AppModalPortal>
          <div className="modal-box" style={{ width: 360 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span>À propos de Story Studio</span>
              <button className="modal-close" onClick={() => setCreditsOpen(false)}>✕</button>
            </div>
            <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)' }}>Story Studio</span>
                {appVersion && <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>v{appVersion}</span>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
                Né d'une envie simple : créer des histoires pour Armand.
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
                Créé par hugs11, assisté de Claude-code et Codex
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', lineHeight: 1.6 }}>
                Grâce au travail de<br />
                <strong style={{ color: 'var(--color-text-secondary)' }}>Jersou</strong>,{' '}
                <strong style={{ color: 'var(--color-text-secondary)' }}>Dantsu</strong>,{' '}
                <strong style={{ color: 'var(--color-text-secondary)' }}>o.Daneel</strong> et{' '}
                <strong style={{ color: 'var(--color-text-secondary)' }}>LuckyTheCookie</strong>
              </div>
            </div>
          </div>
        </AppModalPortal>
      )}
    </div>
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
