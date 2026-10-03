import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useProjectStore } from './store/projectStore';
import { ensureWorkspaceDir } from './store/projectIO';
import { MENU_DEPTH_LIMIT_TITLE, buildProjectIndex } from './store/projectModel';
import { buildToolbarInventory, SUSPENDED_BY_EXPORT, SUSPENDED_BY_GESTURE, toolbarAvailability } from './store/toolbarModel';
import { createProductionCommand } from './store/production/productionRouting';
import {
  MEDIA_LANDING_LIBRARY,
  mediaToolLanding,
  planProducedMediaLanding,
} from './store/mediaToolSurface';
import { ADVANCED_PRODUCTION, runAdvancedProduction } from './store/production/advancedProduction';
import { ADVANCED_WORK } from './store/production/advancedRenderWork';
import { WORK_NATURE } from './store/production/renderQueueWork';
import { exportWorkspaceDir, mediaOutputWorkspaceDir } from './store/workspaceDirs';
import { advancedPackAudioOptions } from './store/production/packAudioOptions';
import { summarizeReadiness } from './store/advancedExport/exportReadiness';
import { archiveNamingFields } from './store/advancedExport/archiveName';
import {
  advancedFieldGovernance,
  advancedCoverImage,
  advancedEntryImagePath,
  advancedImportedIdentity,
  advancedMetadataGesture,
  advancedPackMetadataCounters,
  advancedPackMetadataDraft,
  advancedPackRecap,
  freePackRecap,
  METADATA_SAVE_CLOSED,
  metadataSaveDecision,
} from './store/packMetadataModel';
import { createWorkSnapshot } from './store/projectHelpers';
import { useSdStore } from './store/sdStore';
import { useXttsStore } from './store/xttsStore';
import { useRenderQueueStore } from './store/renderQueueStore';
import { useRenderQueueExecutor } from './hooks/useRenderQueueExecutor';
import { useProjectFileAudit } from './hooks/useProjectFileAudit';
import { useAdvancedBindingAudit } from './hooks/useAdvancedBindingAudit';
import { askImportedUuidRevision } from './hooks/importedUuidRevision';
import { useAdvancedAuthoring } from './hooks/useAdvancedAuthoring';
import { useAdvancedExport } from './hooks/useAdvancedExport';
import { useAdvancedProjectEntry } from './hooks/useAdvancedProjectEntry';
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
import { useAuthorCommandLock } from './hooks/useAuthorCommandLock';
import { useAutosave } from './hooks/useAutosave';
import { useBottomWorkspacePanelModel } from './hooks/useBottomWorkspacePanelModel';
import { useMediaImport } from './hooks/useMediaImport';
import { useMediaLibraryPaths } from './hooks/useMediaLibraryPaths';
import { useMediaToolBridge } from './hooks/useMediaToolBridge';
import { useMediaTransferHandlers } from './hooks/useMediaTransferHandlers';
import { useMissingMediaRelink } from './hooks/useMissingMediaRelink';
import { useOptionsTabProps } from './hooks/useOptionsTabProps';
import { useProjectActionsValue } from './hooks/useProjectActionsValue';
import { useProjectContextValue } from './hooks/useProjectContextValue';
import { useProjectLifecycle } from './hooks/useProjectLifecycle';
import { useProjectLoading } from './hooks/useProjectLoading';
import { useGraphCopy } from './hooks/useGraphCopy';
import { useProjectMutations } from './hooks/useProjectMutations';
import { useSaveProgress } from './hooks/useSaveProgress';
import { askSaveBeforeLeave } from './hooks/saveBeforeLeave';
import { useSessionMediaTriage } from './hooks/useSessionMediaTriage';
import { useSyncedRef } from './hooks/useSyncedRef';
import { useWindowCloseGuard } from './hooks/useWindowCloseGuard';
import { useWorkSession } from './hooks/useWorkSession';
import { useSDJobs } from './hooks/useSDJobs';
import { useXttsJobs } from './hooks/useXttsJobs';
import { useWorkspaceViewState } from './workspace/useWorkspaceViewState';
import { useAdvancedWorkspaceViewState } from './workspace/useAdvancedWorkspaceViewState';
import { isAdvancedProject } from './store/projectWorkState';
import { EDITOR_LAYOUT_SCOPE } from './store/persistentSettings';
import { assessAdvancedProjectReadiness, readAuthoringPayload } from './store/projectModel/authoring';
import { createAdvancedViewBridge } from './store/advancedGraphView/advancedViewBridge';
import { getProjectFilePrefix } from './utils/projectPrefix';
import './styles/variables.css';
import './styles/layout.css';
import './components/layout/AppChrome.css';
import './components/RenderQueuePanel/RenderQueuePanel.css';

function AppContent() {
  const store = useProjectStore();
  const advancedAuthoring = useAdvancedAuthoring({ store });
  const { showErrorDialog, showConfirmDialog, showChoiceDialog } = useErrorDialog();
  useEffect(() => {
    if (!store.mutationError) return;
    showErrorDialog({
      title: store.mutationError.title ?? MENU_DEPTH_LIMIT_TITLE,
      message: store.mutationError.message,
    });
    store.clearMutationError();
  }, [showErrorDialog, store.clearMutationError, store.mutationError]);
  const renderQueue = useRenderQueueStore();
  const [saveToast, setSaveToast] = useState(null); // null | 'ok' | 'error'
  const [, setAutoSavedPath] = useState(null); // path of last autosave (display only)
  const sdStore = useSdStore();
  const xttsStore = useXttsStore();
  // Le témoin du document graphe ouvert, relu par la file au retour d'un travail
  // de cette nature. Il est lu par **ref** parce que l'exécuteur est monté ici,
  // avant la production graphe : une archive revenue après un changement de
  // projet garde son fichier, mais n'est pas présentée comme le résultat du
  // document ouvert, et cette comparaison ne peut pas attendre l'ordre des
  // déclarations.
  const advancedTicketRef = useRef(null);
  const readAdvancedTicket = useCallback(
    () => advancedTicketRef.current?.() ?? { projectEpoch: null, document: null },
    [],
  );
  useRenderQueueExecutor({
    jobs: renderQueue.jobs,
    updateJob: renderQueue.updateJob,
    appendLog: renderQueue.appendLog,
    readAdvancedTicket,
  });
  const workspaceViewState = useWorkspaceViewState();
  const advancedWorkspaceViewState = useAdvancedWorkspaceViewState();
  // Consolidation des booléens d'ouverture de modales/overlays. Les flags
  // qui portent une donnée restent des useState dédiés (toolbarTtsTarget,
  // youtubeFunnelMode, pendingSimulateZip).
  const modals = useDisclosures([
    'credits', 'packOptions', 'record', 'tts', 'podcastImport', 'podcastFunnel',
    'aggregatePacks', 'packChecker', 'editPack', 'prefs', 'validation',
  ]);
  const [toolbarTtsTarget, setToolbarTtsTarget] = useState(null);
  // null = fermé ; 'home' = entrée accueil (session éphémère) ; 'editor' = import
  // dans le projet courant (éditeur libre).
  const [youtubeFunnelMode, setYoutubeFunnelMode] = useState(null);
  // « Modifier un pack » : ZIP à simuler une fois l'éditeur monté
  // (l'ouverture du funnel est portée par la disclosure `editPack`).
  const [pendingSimulateZip, setPendingSimulateZip] = useState(null);
  // Les commandes propres au graphe partent de la barre unique et sont
  // acquittées par l'espace avancé — même grain que `pendingSimulateZip`.
  const [advancedPendingCommand, setAdvancedPendingCommand] = useState(null);
  // Révéler un Écran du graphe depuis une autre surface — la médiathèque.
  // Une **demande acquittée**, comme les commandes de la barre : un
  // chemin d'auteur qui resterait posé rejouerait le recentrage à chaque rendu.
  const [advancedPendingFocusPath, setAdvancedPendingFocusPath] = useState(null);
  // Ce que la barre de titre et la fiche du pack lisent du document d'auteur.
  // La vue avancée en est la seule source ; rien n'en est recopié dans le
  // projet, qui aurait alors deux vérités pour les mêmes valeurs.
  const [advancedDocumentInfo, setAdvancedDocumentInfo] = useState(null);
  // La liste riche du graphe remonte jusqu'à la pastille commune de la
  // barre. `null` signifie que la vue n'a pas encore publié ses diagnostics.
  const [advancedIssuesContext, setAdvancedIssuesContext] = useState(null);
  // Les usages médias du document, remontés par l'espace graphe. `null`
  // veut dire **non calculé** — la vue n'a pas encore été lue —, et non « aucun
  // usage » : la médiathèque affiche alors une absence au lieu d'un zéro.
  const [advancedMediaUsages, setAdvancedMediaUsages] = useState(null);
  // Les chemins des Écrans, par identifiant. La file de rendu peint le
  // compte rendu détaillé d'un travail graphe et ne connaît pas la vue : sans
  // cette correspondance, un identifiant d'Écran reste lisible mais ne conduit
  // plus au nœud. `null` tant que la vue n'est pas lue.
  const [advancedStagePaths, setAdvancedStagePaths] = useState(null);
  // Atteindre un média dans la médiathèque depuis l'emplacement d'un
  // Écran — pour le découper, ou pour l'assembler avec d'autres. Une demande
  // acquittée, comme les deux précédentes. Elle **n'emporte aucun contexte de
  // projet** : le découpage et l'assemblage ne modifient le projet d'aucun
  // côté, et prétendre le contraire par un canal de contexte serait fabriquer
  // une différence entre les deux éditeurs.
  const [pendingMediaReveal, setPendingMediaReveal] = useState(null);
  // Force la modal de métadonnées (version suggérée) à la 1re génération d'un
  // pack importé. Ref (pas state) : lu/écrit synchronement dans le flux de génération.
  const importedPackPendingMetaRef = useRef(false);
  const [importNotice, setImportNotice] = useState(null); // string | null
  const [activeDropZone, setActiveDropZone] = useState(null);
  const projectIndex = useMemo(() => buildProjectIndex(store.project), [store.project]);
  const { statusByPath: pathAudit, pending: pathAuditPending } = useProjectFileAudit(store.project, projectIndex, store.savePath);
  useAdvancedBindingAudit({
    project: store.project,
    syncProjectWithoutHistory: store.syncProjectWithoutHistory,
    statusByPath: pathAudit,
    pending: pathAuditPending,
  });

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
  const backgroundWorkActiveRef = useRef(false);
  const autoSavePathRef = useRef(null); // path of last autosave for never-manually-saved projects
  const autoSaveSnapshotRef = useRef(null); // signature du dernier autosave sans sauvegarde manuelle
  const shortcutActionsRef = useRef({});
  const [treeSearchFocusTrigger, setTreeSearchFocusTrigger] = useState(0);
  const [diagramSearchFocusTrigger, setDiagramSearchFocusTrigger] = useState(0);
  // null = travail jamais sauvegardé/chargé ; sinon signature projet + catalogue Médias
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
  } = useMediaLibraryPaths({
    store,
    sdStore,
    xttsStore,
    workspaceDirRef,
  });

  // Modèle du panneau bas + bottombar : état ouvert/onglet (persistés), ouverture auto
  // depuis la file de rendu, compteurs médias/IA. Appelé APRÈS useMediaLibraryPaths
  // (mediaLibraryPaths) et AVANT useAiGeneration, qui consomme setOpen/setActiveTab pour
  // ouvrir la file IA. mediaLibraryCountRef est fournie ici (consommée par
  // useWorkSession/useAutosave) et synchronisée par le hook.
  const bottomWorkspace = useBottomWorkspacePanelModel({
    editorScope: isAdvancedProject(store.project)
      ? EDITOR_LAYOUT_SCOPE.ADVANCED
      : EDITOR_LAYOUT_SCOPE.FREE,
    project: store.project,
    pathAudit,
    sdJobs: sdStore.jobs,
    xttsJobs: xttsStore.jobs,
    sdPendingCount: sdStore.pendingCount,
    xttsPendingCount: xttsStore.pendingCount,
    sdHasResults: sdStore.hasResults,
    xttsHasResults: xttsStore.hasResults,
    mediaLibraryPaths,
    advancedMediaUsages,
    mediaLibraryCountRef,
    renderQueue,
  });
  const currentWorkSnapshot = createWorkSnapshot(store.project, mediaLibraryPaths, store.mediaTags);

  // Machine à sessions (éphémère/projet, reprises après crash, snapshot
  // anti-crash) : toutes les transitions et le nettoyage du dossier de session
  // vivent dans useWorkSession.
  const {
    sessionMode,
    sessionWorkspaceDir,
    sessionRecoveries,
    sessionModeRef,
    ephemeralSnapshotPathRef,
    ephemeralSnapshotSeedStateRef,
    captureWorkSession,
    isWorkSessionCurrent,
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
    showChoiceDialog,
    useWorkspaceForNewProjects,
    configuredWorkspaceDir,
    setConfiguredWorkspaceDir,
    setWorkspaceDirState,
    workspaceDirRef,
    savedSnapshotRef,
    autoSavePathRef,
    autoSaveSnapshotRef,
    setAutoSavedPath,
    setMediaLibraryPaths,
    mediaLibraryCountRef,
    mediaLibraryPaths,
    mediaTags: store.mediaTags,
    currentWorkSnapshot,
    importedPackPendingMetaRef,
  });

  const mediaWorkspaceDir = mediaOutputWorkspaceDir({
    sessionMode,
    sessionWorkspaceDir,
    configuredWorkspaceDir,
  });
  const mediaWorkspaceDirRef = useRef(mediaWorkspaceDir);
  mediaWorkspaceDirRef.current = mediaWorkspaceDir;
  const preferredExportWorkspaceDir = exportWorkspaceDir({
    workspaceEnabled: useWorkspaceForNewProjects,
    configuredWorkspaceDir,
  });
  const exportWorkspaceDirRef = useRef(preferredExportWorkspaceDir);
  exportWorkspaceDirRef.current = preferredExportWorkspaceDir;

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

  const isPristineWork = store.isPristine;
  const readLiveProject = store.readProject;
  const confirmSaveBeforeLeaveCurrent = useCallback((onSave) => askSaveBeforeLeave(() => {
    const project = readLiveProject();
    return {
      project,
      savePath: savePathRef.current,
      projectName: project?.projectName,
      mediaLibraryPaths: mediaLibraryPathsRef.current,
      mediaTags: mediaTagsRef.current,
      savedSnapshot: savedSnapshotRef.current,
      pristine: isPristineWork(),
    };
  }, onSave, showChoiceDialog), [isPristineWork, readLiveProject, showChoiceDialog]);

  const askSaveBeforeLeaveCurrent = useCallback(async (onSave) => {
    if (advancedAuthoring.isLocked()) return false;
    const canLeave = await confirmSaveBeforeLeaveCurrent(onSave);
    if (advancedAuthoring.isLocked()) return false;
    if (canLeave) await cleanupEphemeralSession();
    return canLeave;
  }, [advancedAuthoring.isLocked, cleanupEphemeralSession, confirmSaveBeforeLeaveCurrent]);

  const confirmBackgroundWorkBeforeClose = useCallback(async () => {
    if (!backgroundWorkActiveRef.current) return true;
    const choice = await showChoiceDialog({
      title: 'Travail en cours',
      message: "Un travail est encore en cours. Quitter maintenant l'interrompra.",
      cancelValue: 'stay',
      actions: [
        { value: 'stay', label: 'Rester', kind: 'primary', autoFocus: true },
        { value: 'quit', label: 'Quitter quand même', kind: 'danger-outline' },
      ],
    });
    return choice === 'quit';
  }, [showChoiceDialog]);

  useWindowCloseGuard({
    askSaveBeforeLeave: confirmSaveBeforeLeaveCurrent,
    saveHandlerRef,
    isCloseBlocked: advancedAuthoring.isLocked,
    confirmClose: confirmBackgroundWorkBeforeClose,
    beforeClose: cleanupEphemeralSession,
  });

  useAutosave({
    enabled: autoSaveEnabled || sessionMode === 'ephemeral',
    backupLimit: autoSaveBackupLimit,
    projectRef,
    savedSnapshotRef,
    savePathRef,
    workspaceDirRef,
    autoSavePathRef,
    autoSaveSnapshotRef,
    ephemeralSnapshotPathRef,
    ephemeralSnapshotSeedStateRef,
    sessionModeRef,
    workEpochRef: store.workEpochRef,
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

  useSDJobs(sdStore, mediaWorkspaceDir, handleMediaCreated);
  // La voix demandée depuis la barre du graphe rejoint le catalogue, puis la
  // médiathèque la sélectionne comme le fait déjà l'enregistrement micro. Une
  // génération achevée après changement de projet ne détourne pas le panneau.
  const handleLibraryVoiceReady = useCallback((path, job) => {
    if (job.target?.projectEpoch !== store.workEpochRef.current) return;
    setPendingMediaReveal({ paths: [path], tool: null });
    bottomWorkspace.openTab('media');
  }, [bottomWorkspace, store.workEpochRef]);
  useXttsJobs(xttsStore, applyGeneratedAudioToTarget, mediaWorkspaceDir, handleMediaCreated, handleLibraryVoiceReady);

  const { getAudioJobUsage, getImageJobUsage } = useAiJobUsage({ project: store.project, projectIndex, advancedMediaUsages });

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
    workspaceDirRef: exportWorkspaceDirRef,
    importedPackPendingMetaRef,
    showErrorDialog,
    showChoiceDialog,
  });

  const projectMutations = useProjectMutations({ store });
  const mediaToolBridge = useMediaToolBridge({
    project: store.project,
    statusByPath: pathAudit,
    openMediaTab: () => bottomWorkspace.openTab('media'),
    mutations: projectMutations,
    showErrorDialog,
  });

  // Un objet neuf à chaque demande : deux révélations du même média restent
  // distinctes. Ce gestionnaire doit précéder les hooks et les outils qui
  // l'appellent, notamment l'import et le micro.
  const handleRevealMediaInLibrary = useCallback(({ paths, tool = null }) => {
    const wanted = (paths ?? []).filter(Boolean);
    if (wanted.length === 0) return;
    mediaToolBridge.invalidateRequest();
    setPendingMediaReveal({ paths: wanted, tool });
    bottomWorkspace.openTab('media');
  }, [bottomWorkspace, mediaToolBridge]);

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
    workspaceDir: mediaWorkspaceDir,
    setWorkspaceDirState,
    workspaceDirRef: mediaWorkspaceDirRef,
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
    configuredWorkspaceDir,
    mediaLibraryPathsRef,
    setMediaLibraryPaths,
    autoSaveEnabled,
    autoSaveBackupLimit,
    savedSnapshotRef,
    autoSaveSnapshotRef,
    captureWorkSession,
    isWorkSessionCurrent,
    isSavingRef,
    setSaveToast,
    showErrorDialog,
    setRecentProjects,
    maybeOfferTransferIntoProject,
    // Le dossier trié est celui que l'enregistrement a épinglé à son départ, et
    // non la session devenue courante entre-temps.
    triageSessionMedia: ({ project, savePath, sessionDir, targetWorkspaceDir, transferCopies, isSessionCurrent }) => triageSessionMedia({
      project,
      sessionDir,
      targetWorkspaceDir,
      transferCopies,
      isSessionCurrent,
      projectName: getProjectFilePrefix(project, savePath),
    }),
    onProjectSaved: async (result, options = {}) => {
      // Seule la promotion « Enregistrer comme projet » (handleSaveProjectAs) nettoie
      // le dossier de session et bascule en mode projet. Un enregistrement en place
      // (handleSaveProject) ne doit JAMAIS supprimer la session éphémère en cours.
      if (!options.promote) return;
      // Le projet enregistré et la session de départ sont transmis : c'est sur
      // eux, et non sur l'état courant, que la session vérifie qu'elle est bien
      // celle qu'on promeut et qu'aucune dépendance ne vit plus chez elle.
      await promoteSessionToProject({
        session: options.session,
        isPublicationCurrent: options.isPublicationCurrent,
        project: result?.project ?? null,
        workspaceDir: options.workspaceDir,
        cleanupSession: options.cleanupSession,
      });
    },
  });
  useSyncedRef(persistProjectSnapshotRef, persistProjectSnapshot);

  // Un projet par menus ouvert depuis le graphe devient une proposition de
  // copie graphe. La passerelle a besoin de `applyLoadedProject`, que ce hook
  // fournit : la référence rompt la dépendance circulaire.
  const graphCopyRouteRef = useRef(null);
  const routeLoadedToGraphCopy = useCallback(
    (result) => graphCopyRouteRef.current?.(result) ?? false,
    [],
  );
  const { applyLoadedProject, handleLoad, handleLoadRecent } = useProjectLoading({
    store,
    sdStore,
    xttsStore,
    setMediaLibraryPaths,
    setRecentProjects,
    savedSnapshotRef,
    autoSavePathRef,
    autoSaveSnapshotRef,
    setAutoSavedPath,
    confirmSaveBeforeLeaveCurrent,
    handleSaveProject: handleSave,
    showErrorDialog,
    onProjectLoaded: enterProjectMode,
    onBeforeProjectReplaced: cleanupEphemeralSession,
    routeLoadedProject: routeLoadedToGraphCopy,
  });

  const graphCopy = useGraphCopy({
    projectRef,
    savePathRef,
    handleSave,
    confirmSaveBeforeLeaveCurrent,
    applyLoadedProject,
    onBeforeProjectReplaced: cleanupEphemeralSession,
    showChoiceDialog,
    showErrorDialog,
  });
  useSyncedRef(graphCopyRouteRef, graphCopy.routeLoadedProject);

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
    advancedAuthoring,
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
    importing,
    unpacking,
    handlePodcastFunnelImport,
    handlePodcastEditorImport,
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
    workspaceDirRef: mediaWorkspaceDirRef,
    importedPackPendingMetaRef,
    runFunnelLanding,
    onRevealImportedMedia: (paths) => handleRevealMediaInLibrary({ paths }),
    setImportNotice,
    setActiveDropZone,
    showErrorDialog,
  });
  backgroundWorkActiveRef.current = renderQueue.activeCount > 0
    || sdStore.pendingCount > 0
    || xttsStore.pendingCount > 0
    || importing
    || unpacking;

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
    autoSaveSnapshotRef,
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

  // Entrée avancée : atterrissage d'un pack choisi explicitement dans le funnel
  // « Modifier un pack ». Appelée APRÈS useWorkSession (runFunnelLanding) et
  // useMediaLibraryPaths (setMediaLibraryPaths).
  const { landAdvancedPack, startAdvancedProject, isFreshlyImported } = useAdvancedProjectEntry({
    store,
    runFunnelLanding,
    savedSnapshotRef,
    setMediaLibraryPaths,
    importedPackPendingMetaRef,
  });

  async function handleStartAdvancedProject() {
    try {
      await startAdvancedProject();
    } catch (error) {
      showErrorDialog({
        title: 'Éditeur graphe',
        message: `Impossible de créer le projet : ${error?.message ?? error}`,
      });
    }
  }

  // Session d'édition avancée : un seul geste en vol, réponses périmées jetées,
  // un geste accepté = une étape d'undo. Elle ne fait rien tant qu'aucun projet
  // avancé n'est ouvert — son état reste au repos.

  // Production graphe : elle ne fait pas tourner d'export elle-même. Elle
  // choisit la destination, capture ce qui part, et confie le travail à la file
  // de rendu — la même que celle de l'éditeur Libre. Comme la session
  // d'édition, elle ne fait rien tant qu'aucun projet avancé n'est ouvert.
  const advancedExport = useAdvancedExport({
    store,
    authoring: advancedAuthoring,
    // Le titre et la version du document, pour **nommer le fichier produit** et
    // rien d'autre. Le document qui part reste le payload en mémoire.
    documentInfo: advancedDocumentInfo,
    workspaceDirRef: exportWorkspaceDirRef,
  });
  useSyncedRef(advancedTicketRef, advancedExport.readTicket);

  // La suspension de l'édition pendant une fabrication graphe, **dérivée de la
  // file**. C'est ce qui la fait survivre au déménagement : elle ne dépend plus
  // du tiroir qui la portait, ni d'un composant qui peut se démonter pendant que
  // l'archive s'écrit. Décision utilisateur du 16 septembre 2026 — l'auteur est
  // suspendu dès le clic, attente dans la file comprise, et jusqu'à ce qu'il ne
  // reste plus rien à fabriquer.
  //
  // La prise est demandée une seconde fois ici, et c'est voulu : elle a déjà été
  // prise par la préparation, avant la capture du document. Cet effet est le
  // **relâchement** qui manquait, et il ne se trompe pas de moment parce qu'il
  // lit la file plutôt qu'une promesse.
  const advancedWorkActive = renderQueue.advancedWorkActive;
  const { hold: holdAuthoring, releaseHold: releaseAuthoring } = advancedAuthoring;
  useEffect(() => {
    if (advancedWorkActive) holdAuthoring('export');
    else releaseAuthoring();
  }, [advancedWorkActive, holdAuthoring, releaseAuthoring]);

  // Le verrou d'auteur de l'export tient les **commandes**, pas seulement les
  // boutons de la barre avancée : clavier, garde de fermeture de la fenêtre et
  // transitions de projet entrent par ces mêmes fonctions. Toutes les surfaces
  // reçoivent désormais la table gardée, de sorte qu'aucune porte ne contourne
  // le verrou. La navigation de vue et l'annulation de l'export n'en sont pas :
  // elles ne mutent rien et restent la seule sortie pendant l'écriture.
  const commands = useAuthorCommandLock({
    isLocked: advancedAuthoring.isLocked,
    commands: {
      undo: store.undo,
      redo: store.redo,
      save: handleSave,
      saveAs: handleSaveProjectAs,
      newProject: handleNewProject,
      openProject: handleLoad,
      openPack: handleEditExistingPack,
      openRecentProject: handleLoadRecent,
      continueInGraph: graphCopy.continueInGraph,
    },
  });

  useSyncedRef(saveHandlerRef, commands.save);
  useSyncedRef(saveAsHandlerRef, commands.saveAs);

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
  // consomme canGenerate/canImportStories/canAddFolder.
  const {
    projectType,
    hasTree,
    projectOpen,
    authoringMode,
    isAdvanced,
    selectedNode,
    validationIssues,
    allMenus,
    showMissingMediaRelink,
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
    workspaceViewState,
    savedSnapshotRef,
    mediaLibraryPaths,
    workspaceDirRef: exportWorkspaceDirRef,
    keyboardShortcuts,
    xttsSettings,
  });

  // Une notice d'ouverture ne survit pas au retour à l'accueil : elle parle du
  // projet qu'on vient de quitter.
  useEffect(() => {
    if (!projectOpen) setImportNotice(null);
  }, [projectOpen]);

  // ── La production, un seul parcours ──────────────────────────────────────
  // Le bouton de la barre et le raccourci appellent **une seule** fonction :
  // c'est ce qui les empêche de diverger. Elle achemine vers la chaîne du
  // projet ouvert, et les deux chaînes traversent les mêmes quatre
  // étapes — la fiche du pack, ce qui bloque, la destination, le départ.
  //
  // Ce que ce parcours ne change pas : les règles de vérification. Il change
  // **où** et **quand** on refuse, jamais ce qui est vérifié, et le moteur
  // refait ses propres contrôles au départ comme avant.
  //
  // Les trois étapes qui suivent la fiche, côté graphe. Leurs règles vivent
  // dans `production/advancedProduction.js`, sans React : ce qui bloque, dans
  // quel ordre on le demande, et ce qu'un refus dit sont éprouvables sans monter
  // d'interface.
  //
  // **La qualification est recalculée à chaque départ**, jamais lue dans l'état
  // que la pastille affiche : elle est dérivée du payload courant, et s'en servir
  // périmée reviendrait à refuser — ou à laisser passer — sur la foi d'une
  // révision que l'auteur a quittée.
  const handleAdvancedProduce = useCallback(async () => {
    let readinessSummary = null;
    // Un refus peut encore tomber à la capture — un projet sans document
    // d'auteur, un dossier perdu entre le sélecteur et l'envoi. Il se rapporte
    // au même endroit que les autres, et le parcours doit le savoir.
    let refusedAtCapture = false;
    const result = await runAdvancedProduction({
      readProject: () => store.project,
      assessReadiness: async (project) => {
        readinessSummary = summarizeReadiness(
          await assessAdvancedProjectReadiness(project),
        );
        return readinessSummary;
      },
      readReferencedMedia: async (project) => {
        const view = await createAdvancedViewBridge().readGraphView(readAuthoringPayload(project));
        return (view.mediaRefs ?? [])
          .map((media) => media.assetRef)
          .filter((assetRef) => typeof assetRef === 'string' && assetRef.trim());
      },
      chooseFolder: advancedExport.chooseFolder,
      // **La quatrième étape ne lance pas l'archive** : elle capture ce qui part
      // et dépose un travail dans la file de rendu, qui le sert quand le poste
      // natif est libre. Le reste du parcours est celui de l'éditeur Libre — les
      // mêmes questions, dans le même ordre, avec les mêmes refus.
      start: async ({ outputFolder, options }) => {
        const prepared = await advancedExport.prepare({ outputFolder, options });
        if (prepared.outcome !== ADVANCED_WORK.PREPARED) {
          refusedAtCapture = true;
          advancedExport.refuseBeforeStart(prepared.refusal);
          return prepared;
        }
        renderQueue.addJob({
          nature: WORK_NATURE.ADVANCED,
          projectName: store.project?.projectName || '(sans nom)',
          savePath: store.savePath ?? null,
          outputFolder,
          request: prepared.request,
          revision: prepared.revision,
          epoch: prepared.epoch,
          ticketDocument: prepared.ticketDocument,
          // La qualification de **cette** révision part avec le travail : les
          // limites lues sous une archive décrivent ce qui a été produit, pas
          // ce que le document est devenu depuis.
          readinessSummary,
        });
        return prepared;
      },
      refuse: advancedExport.refuseBeforeStart,
      // Le traitement demandé vient du projet, les durées des préférences :
      // c'est le même assemblage que `projectToRustExport` fait pour le Libre.
      options: advancedPackAudioOptions(store.project?.globalOptions),
    });
    // La pastille porte ce qui parle du document **avant** la fabrication : la
    // qualification, et le refus prononcé sans rien demander au moteur. Elle
    // s'ouvre donc sur un refus ; un travail parti se suit
    // dans la file, et un abandon au sélecteur de dossier n'a rien à rapporter.
    if (result.outcome === ADVANCED_PRODUCTION.REFUSED || refusedAtCapture) {
      setAdvancedPendingCommand('export');
    }
    return result;
  }, [store, advancedExport, renderQueue]);

  // Les deux chaînes commencent donc par **la même étape** : la fiche du pack.
  // Côté Libre elle est ouverte par `handleGenerate`, qui la connaît depuis
  // toujours ; côté graphe elle l'est ici, et son bouton « Appliquer & générer »
  // enchaîne sur les trois étapes suivantes.
  const handleProduce = useMemo(() => createProductionCommand({
    readWorkspaceMode: () => authoringMode,
    startFree: handleGenerate,
    startAdvanced: () => packMetadata.openPackMetadata(),
  }), [authoringMode, handleGenerate, packMetadata]);

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

  // ── Le point d'arrivée des outils de son ─────────────────────────────────
  // Les quatre outils sont les mêmes des deux côtés ; ce qui change est où
  // leur résultat atterrit. Côté Libre, une histoire dans le dossier visé,
  // comme avant. Côté graphe, la bibliothèque de médias : l'auteur pose
  // ensuite le son sur l'Écran de son choix par le geste de dépôt, et
  // **aucun Écran n'est créé par le seul fait d'avoir produit un son**.
  const mediaToolsLanding = mediaToolLanding(authoringMode);

  function handleToolbarStoryTts() {
    // La file de rendu IA dépose déjà tout audio généré dans la bibliothèque.
    // Côté graphe, la cible ne demande donc rien de plus ; côté Libre, elle
    // demande en outre l'histoire, dans le dossier visé.
    setToolbarTtsTarget(mediaToolsLanding === MEDIA_LANDING_LIBRARY
      ? { kind: 'mediaLibrary', projectEpoch: store.workEpochRef.current }
      : { kind: 'newStory', menuId: toolbarTargetMenuId() });
    modals.open('tts');
  }

  function handleToolbarRecordSaved(path) {
    const plan = planProducedMediaLanding({
      landing: mediaToolsLanding,
      audioPath: path,
      targetMenuId: toolbarTargetMenuId(),
    });
    if (plan?.kind === MEDIA_LANDING_LIBRARY) {
      addPathsToMediaLibrary(plan.paths);
      // L'enregistrement se voit là où il a atterri : sans ce recentrage, le
      // micro se fermerait sur un écran inchangé et l'auteur n'aurait aucun
      // signe que quoi que ce soit a été produit.
      handleRevealMediaInLibrary({ paths: plan.paths });
    } else if (plan) {
      store.addStory(plan.menuId, plan.audioPath);
    }
    modals.close('record');
  }

  // ── La barre unique ──────────────────────────────────────────────────────
  // L'inventaire des commandes est bâti **une fois**, ici, et lu par deux
  // consommateurs : la barre, qui le peint, et la table des raccourcis, qui y
  // prend ses disponibilités. C'est ce qui fait que le clavier et la souris
  // disent la même chose, verrous compris — une disponibilité recalculée d'un
  // côté finirait par diverger de l'autre.
  const advancedReadiness = advancedIssuesContext?.readiness;
  const advancedGeneratePending = isAdvanced && (
    pathAuditPending || !advancedReadiness || advancedReadiness.status !== 'ready'
    || advancedReadiness.stale || !advancedReadiness.summary
  );
  const advancedGenerateBlocked = isAdvanced && !advancedGeneratePending && (
    advancedReadiness.summary.blocked || (advancedIssuesContext?.blockingIssues?.length ?? 0) > 0
  );
  const toolbarInventory = useMemo(() => buildToolbarInventory({
    workspaceMode: authoringMode,
    shortcutLabels,
    canUndo: store.canUndo,
    canRedo: store.canRedo,
    editingLocked: advancedAuthoring.locked,
    gestureBusy: advancedAuthoring.busy,
    generateDisabled: isAdvanced ? advancedGenerateBlocked : !canGenerate,
    generatePending: advancedGeneratePending,
    // Côté graphe, la fiche du pack et la qualification lisent toutes deux le
    // document. Tant que l'espace avancé n'en a pas publié la première lecture,
    // la production n'a rien à ouvrir : le bouton est éteint et dit pourquoi,
    // comme la pastille du pack se retient de peindre un récapitulatif vide.
    documentUnread: isAdvanced && !advancedDocumentInfo,
  }), [
    authoringMode, shortcutLabels, store.canUndo, store.canRedo,
    advancedAuthoring.locked, advancedAuthoring.busy, canGenerate,
    advancedGenerateBlocked, advancedGeneratePending,
    isAdvanced, advancedDocumentInfo,
  ]);
  const toolbarCommands = useMemo(() => toolbarAvailability(toolbarInventory), [toolbarInventory]);

  // L'espace avancé acquitte sa demande dès qu'il l'a consommée : une demande
  // qui resterait posée rouvrirait le dialogue au rendu suivant.
  const handleAdvancedCommandConsumed = useCallback(() => setAdvancedPendingCommand(null), []);
  const handleAdvancedFocusConsumed = useCallback(() => setAdvancedPendingFocusPath(null), []);
  const handleMediaRevealConsumed = useCallback(() => setPendingMediaReveal(null), []);
  // Le récapitulatif du bandeau, composé là où l'on sait ce que la structure
  // porte : l'arbre a un âge minimum, le document de graphe n'en a pas.
  const packRecap = isAdvanced
    ? advancedPackRecap(advancedDocumentInfo)
    : freePackRecap(store.project, projectType);

  // La fiche du pack côté graphe. Le brouillon, la gouvernance des champs et
  // les compteurs viennent tous de `packMetadataModel` : c'est lui qui tient la
  // vérité unique, et l'écriture passe par un geste d'auteur annulable — jamais
  // par une copie dans l'enveloppe du projet.
  //
  // **Mémoïsé, et c'est une condition de correction, pas une optimisation.** La
  // fiche resynchronise son brouillon sur ce qu'elle reçoit ; un objet neuf à
  // chaque rendu de l'hôte effacerait la saisie en cours à chaque battement de
  // l'export. Même famille que la boucle de rendu corrigée par `a91ecca`.
  const advancedMediaBindings = store.project?.authoring?.mediaBindings ?? null;
  const advancedThumbnailImage = store.project?.thumbnailImage ?? null;
  const advancedMetadataForm = useMemo(() => (
    isAdvanced && advancedDocumentInfo
      ? {
          draft: advancedPackMetadataDraft(advancedDocumentInfo, store.project),
          governance: advancedFieldGovernance(advancedDocumentInfo.documentOrigin),
          counters: advancedPackMetadataCounters(
            advancedDocumentInfo,
            advancedMediaBindings ?? [],
          ),
          coverImage: advancedCoverImage(store.project, advancedDocumentInfo.entryImageRef),
          catalogImage: store.project?.thumbnailImage ?? null,
          fallbackImage: advancedEntryImagePath(store.project, advancedDocumentInfo.entryImageRef),
        }
      : null
  ), [isAdvanced, advancedDocumentInfo, advancedMediaBindings, advancedThumbnailImage, store.project]);

  // Appliquer ne ferme pas la fiche par principe.
  //
  // Pendant un export, la session d'auteur rend `held` : elle n'écrit rien, et
  // ne lève pas d'exception. Fermer sur ce retour perdait le texte saisi sans
  // rien dire. La fiche ne se ferme donc que si la demande a abouti, ou s'il
  // n'y avait rien à demander ; sinon elle reste ouverte avec sa saisie et sa
  // raison. Le refus du moteur est protecteur — le défaut était ici.
  const handleSaveAdvancedPackMetadata = useCallback(async (requestedDraft, { generate = false } = {}) => {
    const draft = generate && importedPackPendingMetaRef.current
      ? await askImportedUuidRevision({
          ...requestedDraft,
          originalUuid: advancedImportedIdentity(advancedDocumentInfo),
        }, showChoiceDialog)
      : requestedDraft;
    const gesture = advancedMetadataGesture(advancedDocumentInfo, draft);
    const outcome = gesture ? await advancedAuthoring.runGesture(gesture) : null;
    const decision = metadataSaveDecision(outcome);
    if (decision.result !== METADATA_SAVE_CLOSED) return decision;
    // Le nommage ne part qu'avec une demande aboutie : l'appliquer alors que le
    // geste du document est tenu par un export laisserait la fiche à moitié
    // écrite, sans que rien ne le dise.
    //
    // Il ne passe pas par un geste d'auteur : ces champs ne composent que le
    // nom du fichier exporté et n'entrent dans aucun pack. Ils vivent dans
    // l'enveloppe du projet, exactement là où la chaîne Libre les garde déjà,
    // et `setProject` leur donne le même pas d'annulation qu'à elle.
    const naming = archiveNamingFields(draft?.naming ?? {});
    const current = archiveNamingFields(store.project?.packMetadata ?? {});
    const changed = Object.keys(naming).some((field) => naming[field] !== current[field]);
    if (changed) {
      store.setProject((project) => ({
        ...project,
        packMetadata: { ...(project.packMetadata ?? {}), ...naming },
      }));
    }
    // La vignette catalogue est un média d'**enveloppe**, pas un nœud du
    // graphe : elle s'écrit comme le nommage, par `updateRootMedia`, et non par
    // un geste d'auteur. Sans elle, l'export reprend l'image de l'Écran d'entrée.
    if (Object.hasOwn(draft ?? {}, 'catalogImage')) {
      store.updateRootMedia('thumbnailImage', draft.catalogImage ?? null);
    }
    packMetadata.close();
    if (generate) importedPackPendingMetaRef.current = false;
    // ── Étapes 2 à 4 du parcours ───────────────────────────────────────────
    // La fiche vient d'aboutir ; ce qui bloque est demandé maintenant, puis la
    // destination, puis le travail part. L'ordre est celui de la chaîne Libre,
    // et le refus arrive **avant** que l'auteur choisisse un dossier.
    if (generate) await handleAdvancedProduce();
    return decision;
  }, [advancedDocumentInfo, advancedAuthoring, packMetadata, store, handleAdvancedProduce, showChoiceDialog]);
  // La raison de la suspension est dite **à côté** des commandes tenues, jamais
  // à leur place : l'auteur doit comprendre pourquoi une commande ne répond pas.
  const suspensionNotice = advancedAuthoring.locked
    ? SUSPENDED_BY_EXPORT
    : advancedAuthoring.busy ? SUSPENDED_BY_GESTURE : null;

  // Table d'actions des raccourcis : écrit shortcutActionsRef pendant le rendu,
  // lue par les listeners de useAppShortcuts.
  useAppShortcutActions({
    shortcutActionsRef,
    store,
    modals,
    workspaceViewState,
    setTreeSearchFocusTrigger,
    setDiagramSearchFocusTrigger,
    commands,
    editingLocked: advancedAuthoring.locked,
    handleAddStory,
    // Le raccourci de production appelle la **même** action gardée que le
    // bouton, dans les deux éditeurs.
    handleGenerate: handleProduce,
    projectType,
    workspaceMode: authoringMode,
    advancedNodeListVisible: advancedWorkspaceViewState.showNodeList,
    // Les disponibilités communes viennent de l'inventaire de la
    // barre : bouton et raccourci ne peuvent plus diverger.
    toolbarCommands,
    projectOpen,
    hasProjectTree: hasTree,
    canImportStories,
    canAddFolder,
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
    onOpenMediaAudioTool: mediaToolBridge.openMediaAudioTool,
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
    workspaceDir: mediaWorkspaceDir,
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
    toolbarTtsTarget,
    project: store.project,
    savePath: store.savePath,
    projectType,
    workspaceDir: mediaWorkspaceDir,
    projectName: effectiveProjectFilePrefix,
    appVersion,
    xttsSettings,
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
    advancedMetadataForm,
    onSaveAdvancedPackMetadata: handleSaveAdvancedPackMetadata,
    onLandEditablePack: handleLandEditablePack,
    onLandAdvancedPack: landAdvancedPack,
    onBeforeReplacePack: () => askSaveBeforeLeaveCurrent(handleSave),
    onSimulatePackReady: handleSimulatePackReady,
    onPodcastFunnelImport: handlePodcastFunnelImport,
    onPodcastEditorImport: handlePodcastEditorImport,
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
      prepareMediaForProject: maybeCopyToProject,
      notifyCutPaste,
      activeDropZone,
      setActiveDropZone,
    },
    projectContextValue,
    projectActions,
    projectOpen,
    titleBar: {
      projectName: titleBarName,
      packRecap,
      // La couverture du pack. En Libre, les médias de la racine de l'arbre ;
      // côté graphe, la même que la fiche du pack, c'est-à-dire celle que
      // l'export écrira : la vignette de l'enveloppe, sinon l'image de l'Écran
      // d'entrée.
      packCoverImage: isAdvanced
        ? (advancedMetadataForm?.coverImage ?? null)
        : (hasTree ? (store.project.thumbnailImage || store.project.rootImage) : null),
      isDirty: projectDirty,
      hasSavePath: !!store.savePath,
      saveState: saveToast,
      // Le bandeau et ses métadonnées suivent « un projet est ouvert »,
      // et sont donc atteignables depuis l'éditeur graphe.
      showProjectMeta: projectOpen,
      onOpenPackMetadata: projectOpen ? packMetadata.openPackMetadata : null,
      onOpenCredits: () => modals.open('credits'),
    },
    // La barre unique. Son contenu vient de l'inventaire ; ce groupe ne porte
    // plus que les gestionnaires et l'état des widgets structurels.
    toolbar: {
      inventory: toolbarInventory,
      shortcutLabels,
      suspensionNotice,
      onNewProject: commands.newProject,
      onOpenProject: commands.openProject,
      onOpenPack: commands.openPack,
      onSaveProject: commands.save,
      onSaveProjectAs: commands.saveAs,
      onContinueInGraph: commands.continueInGraph,
      onUndo: commands.undo,
      onRedo: commands.redo,
      onOpenPreferences: () => modals.open('prefs'),
      panels: isAdvanced ? {
        showGraph: true,
        showNodeList: advancedWorkspaceViewState.showNodeList,
        showInspector: advancedWorkspaceViewState.showInspector,
      } : {
        showTree: workspaceViewState.showTree,
        showSettings: workspaceViewState.showSettings,
        showDiagram: workspaceViewState.showDiagram,
      },
      panelOrder: isAdvanced
        ? advancedWorkspaceViewState.panelOrder
        : workspaceViewState.panelOrder,
      onMovePanel: isAdvanced
        ? advancedWorkspaceViewState.movePanel
        : workspaceViewState.movePanel,
      onToggleTree: workspaceViewState.toggleTree,
      onToggleSettings: workspaceViewState.toggleSettings,
      onToggleDiagram: workspaceViewState.toggleDiagram,
      onToggleNodeList: advancedWorkspaceViewState.toggleNodeList,
      onToggleInspector: advancedWorkspaceViewState.toggleInspector,
      packOptionsOpen: modals.isOpen('packOptions'),
      onPackOptionsOpenChange: (open) => modals.set('packOptions', open),
      projectType: store.project.projectType,
      globalOptions: store.project.globalOptions,
      onUpdateGlobalOption: handleUpdateGlobalOption,
      onGenerate: handleProduce,
      issueKind: isAdvanced ? 'advanced' : 'hierarchical',
      validationIssues,
      advancedIssues: isAdvanced ? advancedIssuesContext : null,
      pathAuditPending,
      validationOpen: modals.isOpen('validation'),
      onValidationOpenChange: (open) => modals.set('validation', open),
      onSelectIssue: (id) => {
        if (!id) return;
        store.setSelectedId(id);
        if (!workspaceViewState.showSettings) workspaceViewState.restoreSettings();
      },
    },
    workspace: {
      project: store.project,
      projectEpoch: store.workEpochRef.current,
      node: selectedNode,
      selectedId: store.selectedId,
      onSetProjectType: handleSelectProjectType,
      onStartAdvancedProject: handleStartAdvancedProject,
      onEditPack: commands.openPack,
      onPodcastFunnel: () => modals.open('podcastFunnel'),
      onYoutubeFunnel: () => setYoutubeFunnelMode('home'),
      onAggregatePacks: () => modals.open('aggregatePacks'),
      onCheckPack: () => modals.open('packChecker'),
      pendingSimulateZipPath: pendingSimulateZip,
      onSimulateConsumed: () => setPendingSimulateZip(null),
      onOpenProject: commands.openProject,
      onOpenPreferences: () => modals.open('prefs'),
      recentProjects,
      onOpenRecentProject: commands.openRecentProject,
      sessionRecoveries,
      onRecoverSession: handleRecoverSession,
      onIgnoreSessionRecovery: handleIgnoreSessionRecovery,
      validationIssues,
      allMenus,
      projectIndex,
      treeSearchFocusTrigger,
      onFocusTreeSearch: () => setTreeSearchFocusTrigger((n) => n + 1),
      diagramSearchFocusTrigger,
      workspaceViewState,
      // Le groupe avancé n'est bâti que lorsqu'un projet avancé est ouvert :
      // sans lui, `WorkspaceView` monte l'accueil ou l'espace hiérarchique,
      // exactement comme sans projet avancé.
      advanced: isAdvanced ? {
        payload: readAuthoringPayload(store.project),
        projectDescriptor: {
          packIdentity: null,
          savePath: store.savePath,
          sessionDir: sessionMode === 'ephemeral' ? workspaceDir : null,
        },
        projectEpoch: store.workEpochRef.current,
        freshlyImported: isFreshlyImported(store.workEpochRef.current),
        authoring: advancedAuthoring,
        exportState: advancedExport,
        // Fichier, historique et créations sont partis dans la barre unique.
        // Il ne reste ici que le canal des demandes et la remontée de ce que le
        // bandeau et la fiche du pack lisent du document.
        pendingCommand: advancedPendingCommand,
        onCommandConsumed: handleAdvancedCommandConsumed,
        pendingFocusPath: advancedPendingFocusPath,
        onFocusPathConsumed: handleAdvancedFocusConsumed,
        onDocumentInfo: setAdvancedDocumentInfo,
        onMediaUsages: setAdvancedMediaUsages,
        onStagePaths: setAdvancedStagePaths,
        issuesOpen: modals.isOpen('validation'),
        onIssuesContext: setAdvancedIssuesContext,
        onOpenIssues: () => modals.open('validation'),
        panelViewState: advancedWorkspaceViewState,
        searchFocusTrigger: treeSearchFocusTrigger,
        // Vrai tant que la file porte une fabrication graphe : la pastille le
        // dit, et l'édition est suspendue pendant tout ce temps.
        working: renderQueue.advancedWorkActive,
      } : null,
    },
    bottomPanel: {
      editorScope: bottomWorkspace.editorScope,
      heightKey: bottomWorkspace.heightKey,
      open: bottomWorkspace.open,
      activeTab: bottomWorkspace.activeTab,
      onActiveTabChange: (tab) => {
        if (tab !== 'media') mediaToolBridge.invalidateRequest();
        bottomWorkspace.setActiveTab(tab);
      },
      onClose: () => {
        mediaToolBridge.invalidateRequest();
        bottomWorkspace.close();
      },
      project: store.project,
      pathAudit,
      sdJobs: sdStore.jobs,
      xttsJobs: xttsStore.jobs,
      mediaLibraryPaths,
      advancedMediaUsages,
      onImportStories: () => handleAddStory(),
      onImportMedia: handleImportMediaLibrary,
      onImportMediaFolder: handleImportMediaLibraryFolder,
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
        if (!workspaceViewState.showSettings) workspaceViewState.restoreSettings();
      },
      // L'équivalent graphe de `onSelectNode` : côté arbre on sélectionne un
      // nœud et on ouvre ses réglages, côté graphe on recentre le canvas sur
      // l'Écran. Aucun des deux n'écrit dans le projet.
      onRevealGraphNode: setAdvancedPendingFocusPath,
      renderQueue,
      // Les raccords dont la file a besoin pour peindre le compte rendu d'un
      // travail graphe. `null` sans projet graphe ouvert : la ligne reste
      // consultable — chemin, détail, dossier —, seuls les gestes qui demandent
      // un canvas disparaissent. Décision utilisateur du 16 septembre 2026.
      renderQueueAdvanced: isAdvanced ? {
        stagePaths: advancedStagePaths,
        onFocusPath: setAdvancedPendingFocusPath,
        onOpenDiagnostics: () => modals.open('validation'),
        onReview: advancedExport.openReview,
      } : null,
      mediaTags: store.mediaTags,
      onAddMediaTag: store.addMediaTag,
      onRemoveMediaTag: store.removeMediaTag,
      onDeleteMedia: handleDeleteMedia,
      workspaceDir: mediaWorkspaceDir,
      savePath: store.savePath,
      projectName: effectiveProjectFilePrefix,
      onMediaCreated: handleMediaCreated,
      mediaToolRequest: mediaToolBridge.activeRequest,
      onAcknowledgeMediaToolRequest: mediaToolBridge.acknowledgeRequest,
      onInvalidateMediaToolRequest: mediaToolBridge.invalidateRequest,
      onValidateMediaToolRequest: mediaToolBridge.validateRequest,
      onApplyMediaToolProjectAction: mediaToolBridge.applyProjectAction,
      pendingMediaReveal,
      onMediaRevealConsumed: handleMediaRevealConsumed,
    },
    appModalsProps,
    bottomBar: {
      statusText,
      // Les trois boutons suivent « un projet est ouvert » : ils
      // ouvrent la médiathèque et les deux files, qui n'ont pas besoin d'arbre.
      projectOpen,
      open: bottomWorkspace.open,
      mediaLibraryCount: bottomWorkspace.mediaLibraryCount,
      renderQueueActiveCount: renderQueue.activeCount,
      renderQueueHasResults: renderQueue.hasResults,
      aiQueueActiveCount: bottomWorkspace.aiQueueActiveCount,
      aiQueueHasResults: bottomWorkspace.aiQueueHasResults,
      onOpenMedia: () => {
        mediaToolBridge.invalidateRequest();
        bottomWorkspace.openTab('media');
      },
      onOpenRenderQueue: () => bottomWorkspace.openTab('queue'),
      onOpenAiQueue: handleOpenAiQueue,
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
