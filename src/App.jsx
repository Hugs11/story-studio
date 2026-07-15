import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useProjectStore } from './store/projectStore';
import { ensureWorkspaceDir } from './store/projectIO';
import { buildProjectIndex } from './store/projectModel';
import { isProjectDirty } from './store/projectHelpers';
import { useSdStore } from './store/sdStore';
import { useXttsStore } from './store/xttsStore';
import { useRenderQueueStore } from './store/renderQueueStore';
import { useRenderQueueExecutor } from './hooks/useRenderQueueExecutor';
import { useProjectFileAudit } from './hooks/useProjectFileAudit';
import { ErrorDialogProvider, useErrorDialog } from './components/common/Dialog';
import { AppShell } from './components/AppShell';
import { useAppBootstrap } from './hooks/useAppBootstrap';
import { useEscapeKey } from './hooks/useEscapeKey';
import { useDisclosures } from './hooks/useDisclosures';
import { useAiGeneration } from './hooks/useAiGeneration';
import { useAiJobUsage } from './hooks/useAiJobUsage';
import { usePackGeneration } from './hooks/usePackGeneration';
import { useAppDerivedState } from './hooks/useAppDerivedState';
import { useAppPreferences } from './hooks/useAppPreferences';
import { useAppShortcutActions } from './hooks/useAppShortcutActions';
import { useAppShortcuts } from './hooks/useAppShortcuts';
import { useAutosave } from './hooks/useAutosave';
import { useBottomWorkspacePanelModel } from './hooks/useBottomWorkspacePanelModel';
import { useMediaImport } from './hooks/useMediaImport';
import { useMediaLibraryPaths } from './hooks/useMediaLibraryPaths';
import { useMediaTransferHandlers } from './hooks/useMediaTransferHandlers';
import { useMissingMediaRelink } from './hooks/useMissingMediaRelink';
import { useOptionsTabProps } from './hooks/useOptionsTabProps';
import { useProjectActionsValue } from './hooks/useProjectActionsValue';
import { useProjectContextValue } from './hooks/useProjectContextValue';
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
import { getProjectFilePrefix } from './utils/projectPrefix';
import './styles/variables.css';
import './styles/layout.css';
import './components/layout/AppChrome.css';
import './components/RenderQueuePanel/RenderQueuePanel.css';

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
  const sdStore = useSdStore();
  const xttsStore = useXttsStore();
  useRenderQueueExecutor({ jobs: renderQueue.jobs, updateJob: renderQueue.updateJob, appendLog: renderQueue.appendLog });
  const diagramView = useDiagramViewState();
  // Consolidation des booléens d'ouverture de modales/overlays. Les flags
  // qui portent une donnée restent des useState dédiés (toolbarTtsTargetMenuId,
  // youtubeFunnelMode, pendingSimulateZip).
  const modals = useDisclosures([
    'credits', 'packOptions', 'record', 'tts', 'podcastImport', 'podcastFunnel',
    'aggregatePacks', 'packChecker', 'editPack', 'prefs', 'validation',
  ]);
  const [toolbarTtsTargetMenuId, setToolbarTtsTargetMenuId] = useState(null);
  // null = fermé ; 'home' = entrée accueil (session éphémère) ; 'editor' = import
  // dans le projet courant (éditeur libre).
  const [youtubeFunnelMode, setYoutubeFunnelMode] = useState(null);
  // « Modifier un pack » : ZIP à simuler une fois l'éditeur monté
  // (l'ouverture du funnel est portée par la disclosure `editPack`).
  const [pendingSimulateZip, setPendingSimulateZip] = useState(null);
  // Force la modal de métadonnées (version suggérée) à la 1re génération d'un
  // pack importé. Ref (pas state) : lu/écrit synchronement dans le flux de génération.
  const importedPackPendingMetaRef = useRef(false);
  const [importNotice, setImportNotice] = useState(null); // string | null
  const [activeDropZone, setActiveDropZone] = useState(null);
  const projectIndex = useMemo(() => buildProjectIndex(store.project), [store.project]);
  const { statusByPath: pathAudit, pending: pathAuditPending } = useProjectFileAudit(store.project, projectIndex, store.savePath);

  // Bootstrap applicatif : version, préférences globales persistées, refs
  // synchronisées (workspace/raccourcis) et effets thème/logging/raccourcis. Appelé
  // AVANT useWorkSession, qui consomme configuredWorkspaceDir/setConfiguredWorkspaceDir/
  // setWorkspaceDirState/workspaceDirRef. Positionné ici (après useProjectFileAudit)
  // pour laisser ses effets de sync de ref dans leur créneau d'origine. L'effet
  // ensureWorkspaceDir reste chez l'hôte (il lit sessionModeRef, né plus bas dans
  // useWorkSession).
  const {
    appVersion,
    xttsSettings,
    setXttsSettings,
    keyboardShortcuts,
    setKeyboardShortcuts,
    keyboardShortcutsRef,
    themePreference,
    setThemePreference,
    recentProjects,
    setRecentProjects,
    copyImportedFilesEnabled,
    setCopyImportedFilesEnabled,
    configuredWorkspaceDir,
    setConfiguredWorkspaceDir,
    workspaceDir,
    setWorkspaceDirState,
    workspaceDirRef,
    useWorkspaceForNewProjects,
    setUseWorkspaceForNewProjects,
    autoSaveEnabled,
    setAutoSaveEnabled,
    autoSaveBackupLimit,
    setAutoSaveBackupLimit,
    verboseLogging,
    setVerboseLoggingState,
    dismissedTransferPromptRef,
  } = useAppBootstrap();

  const projectRef = useRef(store.project);
  const savePathRef = useRef(store.savePath);
  const mediaTagsRef = useRef(store.mediaTags);
  const mediaLibraryCountRef = useRef(0);
  const saveHandlerRef = useRef(null);
  const saveAsHandlerRef = useRef(null);
  const isSavingRef = useRef(false);
  const persistProjectSnapshotRef = useRef(null);
  const autoSavePathRef = useRef(null); // path of last autosave for never-manually-saved projects
  const shortcutActionsRef = useRef({});
  const [treeSearchFocusTrigger, setTreeSearchFocusTrigger] = useState(0);
  const [diagramSearchFocusTrigger, setDiagramSearchFocusTrigger] = useState(0);
  // null = projet vierge (jamais sauvegardé/chargé) ; sinon JSON du projet au dernier save/load
  const savedSnapshotRef = useRef(null);

  projectRef.current = store.project;
  savePathRef.current = store.savePath;
  mediaTagsRef.current = store.mediaTags;

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

  // Modèle du panneau bas + bottombar : état ouvert/onglet (persistés), ouverture auto
  // depuis la file de rendu, compteurs médias/IA. Appelé APRÈS useMediaLibraryPaths
  // (mediaLibraryPaths) et AVANT useAiGeneration, qui consomme setOpen/setActiveTab pour
  // ouvrir la file IA. mediaLibraryCountRef est fournie ici (consommée par
  // useWorkSession/useAutosave) et synchronisée par le hook.
  const bottomWorkspace = useBottomWorkspacePanelModel({
    project: store.project,
    pathAudit,
    sdJobs: sdStore.jobs,
    xttsJobs: xttsStore.jobs,
    sdPendingCount: sdStore.pendingCount,
    xttsPendingCount: xttsStore.pendingCount,
    sdHasResults: sdStore.hasResults,
    xttsHasResults: xttsStore.hasResults,
    mediaLibraryPaths,
    mediaLibraryCountRef,
    renderQueue,
  });

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
    setBottomPanelOpen: bottomWorkspace.setOpen,
    setBottomPanelTab: bottomWorkspace.setActiveTab,
  });

  useSDJobs(sdStore, workspaceDir, handleMediaCreated);
  useXttsJobs(xttsStore, applyGeneratedAudioToTarget, workspaceDir, handleMediaCreated);

  const { getAudioJobUsage, getImageJobUsage } = useAiJobUsage({ project: store.project, projectIndex });

  // Grappe « générer le pack » : étape métadonnées (PackNameModal), gardes de
  // validation, résolution du dossier d'export et enfilement du job dans la file de
  // rendu. `importedPackPendingMetaRef` est partagée avec useWorkSession : le hook la
  // lit et la remet à false.
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

  // Tri des médias de session non utilisés à la promotion.
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

  // On ne propose plus d'enregistrer le projet source APRÈS
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

  // Grappe « funnels média d'accueil » : atterrissage podcast/YouTube + regroupement
  // des appels d'import déjà-hookés
  // (useImportSession/useOsFileDrop, ré-exposés). Appelée APRÈS useMediaTransferHandlers
  // (gestionnaires de copie), useSaveProgress (persistProjectSnapshot) et useWorkSession
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

  // Cycle de vie du projet : nouveau projet (reset vers l'accueil), choix du type
  // (session éphémère) et atterrissage depuis les funnels
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

  // Grappe « préférences & réglages » : dossier workspace, logging verbeux
  // (+ chemins de log), consolidation projet, options globales,
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

  // Modèle de lecture du shell : sélection courante, validation, statut, dirty
  // state, capacités toolbar, labels de raccourcis,
  // dossier d'export modal. Appelé AVANT useAppShortcutActions qui
  // consomme canGenerate/totalIssues/canImportStories/canAddFolder.
  const {
    projectType,
    selectedNode,
    validationIssues,
    allMenus,
    showMissingMediaRelink,
    totalIssues,
    statusText,
    projectDirty,
    titleBarName,
    canImportStories,
    canAddFolder,
    canRecord,
    canGenerateStoryTts,
    shortcutLabels,
    effectiveProjectFilePrefix,
    modalExportFolder,
    canGenerate,
  } = useAppDerivedState({
    store,
    projectIndex,
    pathAudit,
    pathAuditPending,
    missingMedia,
    missingMediaSignature,
    dismissedMissingMediaSignature,
    diagramView,
    savedSnapshotRef,
    workspaceDirRef,
    keyboardShortcuts,
    xttsSettings,
  });

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

  // Table d'actions des raccourcis : écrit shortcutActionsRef pendant le rendu,
  // lue par les listeners de useAppShortcuts.
  useAppShortcutActions({
    shortcutActionsRef,
    store,
    modals,
    diagramView,
    setTreeSearchFocusTrigger,
    setDiagramSearchFocusTrigger,
    handleNewProject,
    handleLoad,
    handleAddStory,
    handleGenerate,
    projectType,
    canImportStories,
    canAddFolder,
    canGenerate,
    totalIssues,
  });

  // Actions projet partagées entre les surfaces d'édition (arbre, réglages, diagramme),
  // consommées via useProjectActions. La valeur agrège des gestionnaires venus de plusieurs
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

  const optionsTabProps = useOptionsTabProps({
    copyImportedFilesEnabled,
    handleCopyImportedFilesChange,
    workspaceDir,
    configuredWorkspaceDir,
    handlePickWorkspaceDir,
    useWorkspaceForNewProjects,
    setUseWorkspaceForNewProjects,
    handleConsolidateProject,
    autoSaveEnabled,
    setAutoSaveEnabled,
    autoSaveBackupLimit,
    setAutoSaveBackupLimit,
    themePreference,
    setThemePreference,
    keyboardShortcuts,
    setKeyboardShortcuts,
    xttsSettings,
    handleUpdateXttsSettings,
    sdSettings: sdStore.sdSettings,
    onUpdateSdSettings: sdStore.updateSdSettings,
    verboseLogging,
    handleVerboseLoggingChange,
    handleCopyLogPath,
    handleResolveLogPath,
    project: store.project,
    savePath: store.savePath,
  });

  const projectContextValue = useProjectContextValue({
    savePath: store.savePath,
    projectName: effectiveProjectFilePrefix,
    workspaceDir,
    project: store.project,
    xttsSettings,
    sdStore,
    xttsStore,
    pathAudit,
    maybeCopyToProject,
    extractAudioEmbeddedImage,
    handleSaveProject,
    handleOpenSDGenerate,
    handleUpdateXttsSettings,
    handleQueueXttsGenerate,
    handleMediaCreated,
  });

  // Mur de props d'`AppModals` (~45 clés) : spread tel quel dans le shell, sans
  // renommer aucune clé pour éviter les fautes de frappe silencieuses.
  const appModalsProps = {
    modals,
    youtubeFunnelMode,
    setYoutubeFunnelMode,
    toolbarTtsTargetMenuId,
    project: store.project,
    savePath: store.savePath,
    projectType,
    workspaceDir,
    projectName: effectiveProjectFilePrefix,
    appVersion,
    xttsSettings,
    sdSettings: sdStore.sdSettings,
    canGenerate,
    canGenerateStoryTts,
    modalExportFolder,
    importedPackPendingMetaRef,
    optionsTabProps,
    sdGenerate,
    onSDGenerate: handleSDGenerate,
    onQueueXttsGenerate: handleQueueXttsGenerate,
    onUpdateXttsSettings: handleUpdateXttsSettings,
    packMetadata,
    onSavePackMetadata: handleSavePackMetadata,
    onLandEditablePack: handleLandEditablePack,
    onSimulatePackReady: handleSimulatePackReady,
    onImportMediaEpisodes: handleImportMediaEpisodes,
    onPodcastFunnelImport: handlePodcastFunnelImport,
    onYoutubeFunnelImport: handleYoutubeFunnelImport,
    onYoutubeEditorImport: handleYoutubeEditorImport,
    importing,
    unpacking,
    showMissingMediaRelink,
    missingMedia,
    missingMediaSignature,
    onApplyMissingMediaRelinks: handleApplyMissingMediaRelinks,
    setDismissedMissingMediaSignature,
    saveProgress,
    saveAsProgress,
    triageRequest,
    importNotice,
    setImportNotice,
    onToolbarRecordSaved: handleToolbarRecordSaved,
  };

  // Groupes de props du shell présentational. Aucune logique métier :
  // uniquement du branchement de valeurs/gestionnaires déjà calculés vers le chrome.
  const appShellProps = {
    mediaTransfer: {
      dropOnNode,
      notifyCutPaste,
      activeDropZone,
      setActiveDropZone,
    },
    projectContextValue,
    projectActions,
    projectType,
    titleBar: {
      projectName: titleBarName,
      packMetadata: projectType === 'pack'
        ? store.project.packMetadata
        : projectType === 'simple'
          ? {
              ...(store.project.packMetadata ?? {}),
              title: store.project.packMetadata?.title || store.project.projectName || '',
            }
          : null,
      packCoverImage: projectType !== null ? (store.project.thumbnailImage || store.project.rootImage) : null,
      isDirty: projectDirty,
      hasSavePath: !!store.savePath,
      saveState: saveToast,
      showProjectMeta: projectType !== null,
      onOpenPackMetadata: projectType !== null ? packMetadata.openPackMetadata : null,
      onOpenCredits: () => modals.open('credits'),
    },
    toolbar: projectType !== null ? {
      showProjectActions: projectType !== null,
      shortcutLabels,
      saveState: saveToast,
      generateDisabled: !canGenerate,
      onNewProject: handleNewProject,
      onOpenProject: handleLoad,
      onSaveProject: handleSave,
      onSaveProjectAs: handleSaveProjectAs,
      panels: {
        showTree: diagramView.showTree,
        showSettings: diagramView.showSettings,
        showDiagram: diagramView.showDiagram,
      },
      onToggleTree: diagramView.toggleTree,
      onToggleSettings: diagramView.toggleSettings,
      onToggleDiagram: diagramView.toggleDiagram,
      packOptionsOpen: modals.isOpen('packOptions'),
      onPackOptionsOpenChange: (open) => modals.set('packOptions', open),
      projectType: store.project.projectType,
      globalOptions: store.project.globalOptions,
      onUpdateGlobalOption: handleUpdateGlobalOption,
      onOpenPreferences: () => modals.open('prefs'),
      onGenerate: handleGenerate,
      validationIssues,
      pathAuditPending,
      validationOpen: modals.isOpen('validation'),
      onValidationOpenChange: (open) => modals.set('validation', open),
      onSelectIssue: (id) => {
        if (!id) return;
        store.setSelectedId(id);
        if (!diagramView.showSettings) diagramView.restoreSettings();
      },
    } : null,
    workspace: {
      project: store.project,
      node: selectedNode,
      selectedId: store.selectedId,
      onSetProjectType: handleSelectProjectType,
      onEditPack: handleEditExistingPack,
      onPodcastFunnel: () => modals.open('podcastFunnel'),
      onYoutubeFunnel: () => setYoutubeFunnelMode('home'),
      onAggregatePacks: () => modals.open('aggregatePacks'),
      onCheckPack: () => modals.open('packChecker'),
      pendingSimulateZipPath: pendingSimulateZip,
      onSimulateConsumed: () => setPendingSimulateZip(null),
      onOpenProject: handleLoad,
      onOpenPreferences: () => modals.open('prefs'),
      recentProjects,
      onOpenRecentProject: handleLoadRecent,
      sessionRecoveries,
      onRecoverSession: handleRecoverSession,
      onIgnoreSessionRecovery: handleIgnoreSessionRecovery,
      pathAudit,
      validationIssues,
      allMenus,
      projectIndex,
      treeSearchFocusTrigger,
      onFocusTreeSearch: () => setTreeSearchFocusTrigger((n) => n + 1),
      diagramSearchFocusTrigger,
      diagramView,
    },
    bottomPanel: {
      open: bottomWorkspace.open,
      activeTab: bottomWorkspace.activeTab,
      onActiveTabChange: bottomWorkspace.setActiveTab,
      onClose: bottomWorkspace.close,
      project: store.project,
      pathAudit,
      sdJobs: sdStore.jobs,
      xttsJobs: xttsStore.jobs,
      mediaLibraryPaths,
      onImportStories: () => handleAddStory(),
      onImportMedia: handleImportMediaLibrary,
      onImportMediaFolder: handleImportMediaLibraryFolder,
      onOpenAiQueue: handleOpenAiQueue,
      onRegenerateImage: handleRegenerateImageJob,
      onClearAiDone: () => {
        sdStore.clearDone();
        xttsStore.clearDone();
      },
      onRemoveImageJob: sdStore.removeJob,
      onRemoveAudioJob: xttsStore.removeJob,
      getAudioUsage: getAudioJobUsage,
      getImageUsage: getImageJobUsage,
      onSelectNode: (id) => {
        store.setSelectedId(id);
        if (!diagramView.showSettings) diagramView.restoreSettings();
      },
      renderQueue,
      mediaTags: store.mediaTags,
      onAddMediaTag: store.addMediaTag,
      onRemoveMediaTag: store.removeMediaTag,
      onDeleteMedia: handleDeleteMedia,
      savePath: store.savePath,
      projectName: effectiveProjectFilePrefix,
      onMediaCreated: handleMediaCreated,
    },
    appModalsProps,
    bottomBar: {
      statusText,
      projectType,
      open: bottomWorkspace.open,
      mediaLibraryCount: bottomWorkspace.mediaLibraryCount,
      renderQueueActiveCount: renderQueue.activeCount,
      renderQueueHasResults: renderQueue.hasResults,
      aiQueueActiveCount: bottomWorkspace.aiQueueActiveCount,
      aiQueueHasResults: bottomWorkspace.aiQueueHasResults,
      onOpenMedia: () => bottomWorkspace.openTab('media'),
      onOpenRenderQueue: () => bottomWorkspace.openTab('queue'),
      onOpenAiQueue: () => bottomWorkspace.openTab('ai'),
      appVersion,
    },
  };

  return <AppShell {...appShellProps} />;
}

export default function App() {
  return (
    <ErrorDialogProvider>
      <AppContent />
    </ErrorDialogProvider>
  );
}
