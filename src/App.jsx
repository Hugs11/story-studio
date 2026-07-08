import { lazy, useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { useProjectStore } from './store/projectStore';
import {
  getRecentProjects,
  ensureWorkspaceDir,
} from './store/projectIO';
import { getLastExportDir } from './hooks/useFileDialog';
import { ProjectContext } from './store/ProjectContext';
import { ProjectActionsContext } from './store/ProjectActionsContext';
import { MediaTransferProvider } from './store/MediaTransferContext';
import { collectMediaLibrary } from './store/mediaLibrary';
import { buildProjectIndex } from './store/projectModel';
import { isProjectDirty } from './store/projectHelpers';
import { KEYS, read as readSetting } from './store/persistentSettings';
import { isTtsAvailable, loadXttsSettings } from './store/xttsSettings';
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
import { TitleBar } from './components/layout/TitleBar';
import { Toolbar } from './components/layout/Toolbar';
import { BottomWorkspacePanel } from './components/BottomWorkspacePanel/BottomWorkspacePanel';
import { ErrorDialogProvider, useErrorDialog } from './components/common/Dialog';
import { AppModals } from './components/AppModals';
import { renderDeferred } from './components/renderDeferred';
import { useEscapeKey } from './hooks/useEscapeKey';
import { useDisclosures } from './hooks/useDisclosures';
import { useAiGeneration } from './hooks/useAiGeneration';
import { useAiJobUsage } from './hooks/useAiJobUsage';
import { usePackGeneration } from './hooks/usePackGeneration';
import { useAppPreferences } from './hooks/useAppPreferences';
import { useAppShortcuts } from './hooks/useAppShortcuts';
import { useAutosave } from './hooks/useAutosave';
import { useMediaImport } from './hooks/useMediaImport';
import { useMediaLibraryPaths } from './hooks/useMediaLibraryPaths';
import { useMediaTransferHandlers } from './hooks/useMediaTransferHandlers';
import { useMissingMediaRelink } from './hooks/useMissingMediaRelink';
import { usePersistentState } from './hooks/usePersistentState';
import { useProjectActionsValue } from './hooks/useProjectActionsValue';
import { useProjectLifecycle } from './hooks/useProjectLifecycle';
import { useProjectLoading } from './hooks/useProjectLoading';
import { useProjectMutations } from './hooks/useProjectMutations';
import { useSaveProgress } from './hooks/useSaveProgress';
import { useSessionMediaTriage } from './hooks/useSessionMediaTriage';
import { useSyncedRef } from './hooks/useSyncedRef';
import { useWindowCloseGuard } from './hooks/useWindowCloseGuard';
import { useWorkSession } from './hooks/useWorkSession';
import { useSDJobs } from './hooks/useSDJobs';
import { useXttsJobs } from './hooks/useXttsJobs';
import { useDiagramViewState } from './workspace/useDiagramViewState';
import { logger, installGlobalErrorHandlers, setLogLevel } from './utils/logger';
import { loadVerboseLoggingPref, verboseLevelName } from './store/loggingPreference';
import { isTauriRuntime } from './utils/tauriRuntime';
import { getProjectFilePrefix } from './utils/projectPrefix';
import { END_NODE_ID } from './components/CentralPanel/flowDiagramLayout';
import './styles/variables.css';
import './styles/layout.css';
import './components/layout/AppChrome.css';
import './components/RenderQueuePanel/RenderQueuePanel.css';

const WorkspaceView = lazy(() => import('./workspace/WorkspaceView').then((module) => ({ default: module.WorkspaceView })));

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
  // Consolidation des booléens d'ouverture de modales/overlays (plan O). Les flags
  // qui portent une donnée restent des useState dédiés (toolbarTtsTargetMenuId,
  // youtubeFunnelMode, pendingSimulateZip).
  const modals = useDisclosures([
    'credits', 'packOptions', 'record', 'tts', 'podcastImport', 'podcastFunnel',
    'aggregatePacks', 'packChecker', 'editPack', 'prefs', 'validation',
  ]);
  const [toolbarTtsTargetMenuId, setToolbarTtsTargetMenuId] = useState(null);
  // null = fermé ; 'home' = entrée accueil (session éphémère) ; 'editor' = import
  // dans le projet courant (éditeur libre). Plan 09.
  const [youtubeFunnelMode, setYoutubeFunnelMode] = useState(null);
  const [copyImportedFilesEnabled, setCopyImportedFilesEnabled] = usePersistentState(KEYS.COPY_FILES, false, BOOL_CODEC);
  const [configuredWorkspaceDir, setConfiguredWorkspaceDir] = useState(() => readSetting(KEYS.WORKSPACE_DIR, { defaultValue: '' }));
  const [workspaceDir, setWorkspaceDirState] = useState(() => readSetting(KEYS.WORKSPACE_DIR, { defaultValue: '' }));
  const [useWorkspaceForNewProjects, setUseWorkspaceForNewProjects] = usePersistentState(KEYS.USE_WORKSPACE_FOR_NEW_PROJECTS, false, BOOL_CODEC);
  // « Modifier un pack » (plan 04) : ZIP à simuler une fois l'éditeur monté
  // (l'ouverture du funnel est portée par la disclosure `editPack`).
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

  useEscapeKey(modals.isOpen('credits'), () => modals.close('credits'));

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

  const projectMutations = useProjectMutations({ store });

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
    setEditPackOpen: (open) => modals.set('editPack', open),
    setPendingSimulateZip,
    setImportNotice,
    showErrorDialog,
  });

  useSyncedRef(saveHandlerRef, handleSave);
  useSyncedRef(saveAsHandlerRef, handleSaveProjectAs);

  // Grappe « préférences & réglages » (plan N, iso-fonctionnel) : dossier workspace,
  // logging verbeux (+ chemins de log), consolidation projet, options globales,
  // message de fin et réglages XTTS. Appelée APRÈS useSaveProgress (setSaveProgress
  // pilote la progression de handleConsolidateProject) et useWorkSession (sessionMode).
  // xttsSettings reste chez l'hôte (lu par la génération / ProjectContext / OptionsTab) :
  // le hook ne reçoit que setXttsSettings.
  const {
    handlePickWorkspaceDir,
    handleVerboseLoggingChange,
    handleResolveLogPath,
    handleCopyLogPath,
    handleConsolidateProject,
    handleUpdateGlobalOption,
    handleAddEndNode,
    handleRemoveEndNode,
    handleUpdateXttsSettings,
  } = useAppPreferences({
    store,
    sessionMode,
    setConfiguredWorkspaceDir,
    setWorkspaceDirState,
    setVerboseLoggingState,
    setSaveProgress,
    setRecentProjects,
    setXttsSettings,
    showErrorDialog,
    showConfirmDialog,
  });

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
    modals.open('record');
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
    modals.open('tts');
  }

  function handleToolbarRecordSaved(path) {
    store.addStory(toolbarTargetMenuId(), path);
    modals.close('record');
  }
  const canGenerate = projectType !== null && !pathAuditPending && totalIssues === 0;

  useSyncedRef(shortcutActionsRef, {
    newProject: handleNewProject,
    openProject: handleLoad,
    importStories: handleAddStory,
    addFolder: () => store.addMenu(),
    openPackOptions: () => modals.open('packOptions'),
    openPreferences: () => modals.open('prefs'),
    toggleTree: diagramView.toggleTree,
    toggleSettings: diagramView.toggleSettings,
    toggleDiagram: diagramView.toggleDiagram,
    generate: handleGenerate,
    focusTreeSearch: () => setTreeSearchFocusTrigger((n) => n + 1),
    toggleValidation: () => modals.toggle('validation'),
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
  // consommées via useProjectActions. La valeur agrège des handlers venus de plusieurs
  // hooks (mutations, import, préférences, toolbar) ; reconstruite à chaque rendu.
  const projectActions = useProjectActionsValue({
    store,
    mutations: projectMutations,
    mediaImport: {
      handleAddStory,
      handleAddStoryToMenu,
      handleImportFolder,
      handleUnpackZip,
    },
    preferences: {
      handleAddEndNode,
      handleRemoveEndNode,
    },
    toolbar: {
      handleToolbarRecord,
      handleToolbarStoryTts,
    },
    modals,
    setYoutubeFunnelMode,
    canRecord,
    canGenerateStoryTts,
  });

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
        onOpenCredits={() => modals.open('credits')}
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
          packOptionsOpen={modals.isOpen('packOptions')}
          onPackOptionsOpenChange={(open) => modals.set('packOptions', open)}
          projectType={store.project.projectType}
          globalOptions={store.project.globalOptions}
          onUpdateGlobalOption={handleUpdateGlobalOption}
          onOpenPreferences={() => modals.open('prefs')}
          onGenerate={handleGenerate}
          validationIssues={validationIssues}
          pathAuditPending={pathAuditPending}
          validationOpen={modals.isOpen('validation')}
          onValidationOpenChange={(open) => modals.set('validation', open)}
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
              onPodcastFunnel={() => modals.open('podcastFunnel')}
              onYoutubeFunnel={() => setYoutubeFunnelMode('home')}
              onAggregatePacks={() => modals.open('aggregatePacks')}
              onCheckPack={() => modals.open('packChecker')}
              pendingSimulateZipPath={pendingSimulateZip}
              onSimulateConsumed={() => setPendingSimulateZip(null)}
              onOpenProject={handleLoad}
              onOpenPreferences={() => modals.open('prefs')}
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

      <AppModals
        modals={modals}
        youtubeFunnelMode={youtubeFunnelMode}
        setYoutubeFunnelMode={setYoutubeFunnelMode}
        toolbarTtsTargetMenuId={toolbarTtsTargetMenuId}
        project={store.project}
        savePath={store.savePath}
        projectType={projectType}
        workspaceDir={workspaceDir}
        projectName={effectiveProjectFilePrefix}
        appVersion={appVersion}
        xttsSettings={xttsSettings}
        sdSettings={sdStore.sdSettings}
        canGenerate={canGenerate}
        canGenerateStoryTts={canGenerateStoryTts}
        modalExportFolder={modalExportFolder}
        importedPackPendingMetaRef={importedPackPendingMetaRef}
        optionsTabProps={optionsTabProps}
        sdGenerate={sdGenerate}
        onSDGenerate={handleSDGenerate}
        onQueueXttsGenerate={handleQueueXttsGenerate}
        onUpdateXttsSettings={handleUpdateXttsSettings}
        packMetadata={packMetadata}
        onSavePackMetadata={handleSavePackMetadata}
        onLandEditablePack={handleLandEditablePack}
        onSimulatePackReady={handleSimulatePackReady}
        onImportMediaEpisodes={handleImportMediaEpisodes}
        onPodcastFunnelImport={handlePodcastFunnelImport}
        onYoutubeFunnelImport={handleYoutubeFunnelImport}
        onYoutubeEditorImport={handleYoutubeEditorImport}
        importing={importing}
        unpacking={unpacking}
        showMissingMediaRelink={showMissingMediaRelink}
        missingMedia={missingMedia}
        missingMediaSignature={missingMediaSignature}
        onApplyMissingMediaRelinks={handleApplyMissingMediaRelinks}
        setDismissedMissingMediaSignature={setDismissedMissingMediaSignature}
        saveProgress={saveProgress}
        saveAsProgress={saveAsProgress}
        triageRequest={triageRequest}
        importNotice={importNotice}
        setImportNotice={setImportNotice}
        onToolbarRecordSaved={handleToolbarRecordSaved}
        onMediaCreated={handleMediaCreated}
      />

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
