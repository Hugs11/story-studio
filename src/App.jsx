import { Suspense, lazy, useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { sanitizeImportedName, useProjectStore } from './store/projectStore';
import {
  getRecentProjects,
  loadProjectFromPath,
  rememberRecentProject,
  ensureExportsDir,
  ensureWorkspaceDir,
  pickWorkspaceDir,
  getWorkspaceDir,
  consolidateProject,
  projectToRustExport,
  autoSaveEphemeralProject,
  isProjectWorthAutosaving,
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
import { buildProjectIndex } from './store/projectModel';
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
import { useSessionMediaTriage } from './hooks/useSessionMediaTriage';
import { useSyncedRef } from './hooks/useSyncedRef';
import { useWindowCloseGuard } from './hooks/useWindowCloseGuard';
import { useSDJobs } from './hooks/useSDJobs';
import { useXttsJobs } from './hooks/useXttsJobs';
import { logger, installGlobalErrorHandlers, setLogLevel } from './utils/logger';
import { loadVerboseLoggingPref, saveVerboseLoggingPref, verboseLevelName } from './store/loggingPreference';
import { isTauriRuntime } from './utils/tauriRuntime';
import { bumpPackVersion } from './utils/packConvention';
import { getProjectFilePrefix } from './utils/projectPrefix';
import { generateUuid } from './utils/uuid';
import { basename } from './utils/fileUtils';
import './styles/variables.css';
import './styles/layout.css';
import './components/layout/AppChrome.css';
import './components/RenderQueuePanel/RenderQueuePanel.css';

const EditorTab = lazy(() => import('./tabs/EditorTab').then((module) => ({ default: module.EditorTab })));
const DiagramTab = lazy(() => import('./tabs/DiagramTab').then((module) => ({ default: module.DiagramTab })));
const OptionsTab = lazy(() => import('./tabs/OptionsTab').then((module) => ({ default: module.OptionsTab })));
const SDGenerateModal = lazy(() => import('./components/SDGenerateModal/SDGenerateModal').then((module) => ({ default: module.SDGenerateModal })));
const RecordModal = lazy(() => import('./components/RecordModal/RecordModal').then((module) => ({ default: module.RecordModal })));
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
const SESSION_RECOVERY_FILE = '.session-recovery.mbah';

function joinLocalPath(dir, fileName) {
  if (!dir) return '';
  const trimmed = String(dir).replace(/[\\/]+$/, '');
  const sep = String(dir).includes('\\') ? '\\' : '/';
  return `${trimmed}${sep}${fileName}`;
}

function isImportedPackPath(filePath) {
  return /\.(zip|7z)$/i.test(filePath || '');
}

function getImportDisplayName(filePath) {
  const fileName = basename(filePath);
  return sanitizeImportedName(fileName, fileName || 'Import en cours');
}

// Vrai si l'UUID du draft est encore l'UUID importé d'origine (non régénéré via ↺ ni
// modifié). Sert à ne proposer la régénération que quand ça a du sens.
function isImportedOriginalUuid(draft) {
  const current = String(draft?.uuid || '').trim();
  const original = String(draft?.originalUuid || '').trim();
  return !!current && (!original || current === original);
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
  const [sessionRecoveries, setSessionRecoveries] = useState([]);
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
  const [sessionMode, setSessionMode] = useState(null); // null | 'ephemeral' | 'project'
  const [sessionWorkspaceDir, setSessionWorkspaceDir] = useState('');
  // « Modifier un pack » (plan 04) : ouverture du funnel + ZIP à simuler une fois l'éditeur monté.
  const [editPackOpen, setEditPackOpen] = useState(false);
  const [pendingSimulateZip, setPendingSimulateZip] = useState(null);
  // D34 : force la modal de métadonnées (version suggérée) à la 1re génération d'un
  // pack importé. Ref (pas state) : lu/écrit synchronement dans le flux de génération.
  const importedPackPendingMetaRef = useRef(false);
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
  const sessionModeRef = useRef(null);
  const ephemeralSnapshotPathRef = useRef(null);
  const ephemeralSavedSnapshotRef = useRef(null);
  // One-shot : a-t-on déjà écrit le snapshot anti-crash pour cette session ?
  const ephemeralSnapshotSeededRef = useRef(false);
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
    ensureWorkspaceDir().then((dir) => {
      if (cancelled) return;
      setConfiguredWorkspaceDir(dir);
      if (sessionModeRef.current !== 'ephemeral') {
        setWorkspaceDirState(dir);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadRecoveries() {
      try {
        const recoveries = await invoke('list_session_recoveries');
        if (!Array.isArray(recoveries) || recoveries.length === 0) {
          if (!cancelled) setSessionRecoveries([]);
          return;
        }
        const enriched = await Promise.all(recoveries.map(async (recovery) => {
          try {
            const result = await loadProjectFromPath(recovery.snapshotPath);
            return {
              ...recovery,
              projectName: result.data?.projectName || 'Projet récupérable',
              projectType: result.data?.projectType || 'pack',
              thumbnailImage: result.data?.thumbnailImage || result.data?.rootImage || null,
            };
          } catch {
            return {
              ...recovery,
              projectName: 'Projet récupérable',
              projectType: 'pack',
              thumbnailImage: null,
            };
          }
        }));
        if (!cancelled) setSessionRecoveries(enriched);
      } catch {
        if (!cancelled) setSessionRecoveries([]);
      }
    }
    loadRecoveries();
    return () => { cancelled = true; };
  }, []);

  projectRef.current = store.project;
  savePathRef.current = store.savePath;
  mediaTagsRef.current = store.mediaTags;

  useEffect(() => {
    workspaceDirRef.current = workspaceDir;
  }, [workspaceDir]);

  useEffect(() => {
    sessionModeRef.current = sessionMode;
    ephemeralSnapshotPathRef.current = sessionMode === 'ephemeral' && sessionWorkspaceDir
      ? joinLocalPath(sessionWorkspaceDir, SESSION_RECOVERY_FILE)
      : null;
    if (sessionMode !== 'ephemeral') {
      ephemeralSavedSnapshotRef.current = null;
    }
  }, [sessionMode, sessionWorkspaceDir]);

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
    askSaveBeforeLeave(project, savedSnapshot, onSave, showChoiceDialog).then((canLeave) => {
      if (canLeave && sessionModeRef.current === 'ephemeral' && sessionWorkspaceDir) {
        invoke('cleanup_session_workspace', { path: sessionWorkspaceDir }).catch((error) => {
          logger.warn('session:cleanup-error', error);
        });
      }
      return canLeave;
    })
  ), [sessionWorkspaceDir, showChoiceDialog]);

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

  // Filet anti-crash : écrit le snapshot éphémère dès le premier contenu de la
  // session (atterrissage d'un pack importé, podcast/YouTube, ou 1er édit d'un
  // nouveau projet), sans attendre la tick d'autosave (5 min). Une seule fois
  // par session ; le périodique prend le relais ensuite.
  useEffect(() => {
    if (sessionMode !== 'ephemeral') return;
    if (ephemeralSnapshotSeededRef.current) return;
    if (!ephemeralSnapshotPathRef.current) return;
    // Même critère que saveProject(autosave) : n'écrire que si le projet a un
    // contenu réel (sinon saveProject jette « projet vide »). Évite de griller
    // le one-shot sur l'état vierge avant l'atterrissage du contenu.
    if (!isProjectWorthAutosaving(store.project, mediaLibraryPathsRef.current, mediaLibraryCountRef.current)) return;
    const seeded = JSON.stringify(store.project);
    autoSaveEphemeralProject(store.project, sessionWorkspaceDir, ephemeralSnapshotPathRef.current, {
      mediaTags: mediaTagsRef.current,
      mediaLibraryPaths: mediaLibraryPathsRef.current,
      totalMediaCount: mediaLibraryCountRef.current,
    })
      .then(() => {
        // One-shot marqué seulement après écriture réussie.
        ephemeralSnapshotSeededRef.current = true;
        ephemeralSavedSnapshotRef.current = seeded;
      })
      .catch((error) => { logger.error('session:seed-snapshot-error', error); });
  }, [sessionMode, sessionWorkspaceDir, store.project]);

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
    const canContinue = await askSaveBeforeLeaveCurrent(store.project, savedSnapshotRef.current, handleSave);
    if (!canContinue) return;
    if (sessionMode === 'ephemeral' && sessionWorkspaceDir) {
      invoke('cleanup_session_workspace', { path: sessionWorkspaceDir }).catch((error) => {
        logger.warn('session:cleanup-error', error);
      });
    }
    store.resetProject();
    setMediaLibraryPaths([]);
    savedSnapshotRef.current = null;
    autoSavePathRef.current = null;
    ephemeralSavedSnapshotRef.current = null;
    setAutoSavedPath(null);
    setSessionMode(null);
    setSessionWorkspaceDir('');
    setWorkspaceDirState(configuredWorkspaceDir);
    sdStore.clearDone();
    xttsStore.clearDone();
  }

  // Prépare une session de travail (éphémère par défaut, ou workspace réel si
  // l'opt-in D25 est actif), fixe le type de projet et renvoie le dossier cible
  // d'écriture. Partagé par « Nouveau projet » et « Modifier un pack ».
  async function prepareNewWorkSession(type) {
    let workspaceDir;
    if (useWorkspaceForNewProjects) {
      const realWorkspace = configuredWorkspaceDir || await ensureWorkspaceDir();
      if (!configuredWorkspaceDir) setConfiguredWorkspaceDir(realWorkspace);
      setSessionMode('project');
      setSessionWorkspaceDir('');
      setWorkspaceDirState(realWorkspace);
      workspaceDirRef.current = realWorkspace;
      workspaceDir = realWorkspace;
    } else {
      const sessionDir = await invoke('create_session_workspace');
      setSessionMode('ephemeral');
      setSessionWorkspaceDir(sessionDir);
      setWorkspaceDirState(sessionDir);
      workspaceDirRef.current = sessionDir;
      workspaceDir = sessionDir;
    }
    autoSavePathRef.current = null;
    ephemeralSavedSnapshotRef.current = null;
    ephemeralSnapshotSeededRef.current = false;
    setAutoSavedPath(null);
    importedPackPendingMetaRef.current = false;
    store.setSavePath(null);
    store.setProjectType(type);
    logger.info(`session:start mode=${useWorkspaceForNewProjects ? 'project' : 'ephemeral'} type=${type}`);
    return workspaceDir;
  }

  async function handleSelectProjectType(type) {
    try {
      await prepareNewWorkSession(type);
    } catch (error) {
      logger.error('session:start-error', error);
      showErrorDialog({
        title: 'Nouveau projet',
        message: `Impossible de préparer le dossier de travail : ${error}`,
      });
    }
  }

  // Entrée accueil « Modifier un pack » (plan 04) : ouvre le funnel dédié
  // (zone de dépôt fichier/dossier, vérification d'éditabilité D31 et
  // décompression affichées dans le funnel).
  function handleEditExistingPack() {
    setEditPackOpen(true);
  }

  // Pack éditable confirmé par le funnel : crée la session éphémère, extrait le
  // pack (décompression affichée DANS le funnel) puis atterrit dans l'éditeur.
  // Lève en cas d'échec ; la session créée est nettoyée pour revenir proprement
  // à l'accueil (le funnel ré-affiche alors la zone de dépôt).
  async function handleLandEditablePack({ zipPath, packLabel }) {
    const workspaceDir = await prepareNewWorkSession('pack');
    try {
      const transformed = await unpackZipIntoBlankProject({
        zipPath,
        zipName: packLabel,
        workspaceDir,
        baseProject: store.project,
      });
      if (!transformed) throw new Error('Aucune histoire éditable trouvée dans ce pack.');
      // D34 : suggérer une version incrémentée (_V2 si aucune) et forcer la modal
      // de métadonnées pré-remplie à la première génération du pack importé.
      const landedProject = transformed.project.packMetadata
        ? {
            ...transformed.project,
            packMetadata: {
              ...transformed.project.packMetadata,
              version: bumpPackVersion(transformed.project.packMetadata.version),
            },
          }
        : transformed.project;
      store.setProject(landedProject);
      store.setSelectedId('root');
      importedPackPendingMetaRef.current = true;
      if (transformed.advancedTransitionsDetected) {
        const firstWarning = transformed.unresolvedTransitions[0]?.message;
        setImportNotice(
          "Certaines transitions du pack importé n'ont pas pu être modélisées complètement. "
          + "Story Studio a conservé la structure reconnue, mais vérifiez les retours concernés avant export."
          + (firstWarning ? ` Exemple : ${firstWarning}` : '')
        );
      }
      logger.info(`edit-pack:landed zip='${zipPath}'`);
    } catch (error) {
      logger.error('edit-pack:land-error', error);
      // Échec d'extraction : nettoyer la session et revenir à l'accueil.
      if (!useWorkspaceForNewProjects && workspaceDir) {
        invoke('cleanup_session_workspace', { path: workspaceDir }).catch(() => {});
      }
      store.resetProject();
      setSessionMode(null);
      setSessionWorkspaceDir('');
      setWorkspaceDirState(configuredWorkspaceDir);
      workspaceDirRef.current = configuredWorkspaceDir;
      throw error;
    }
  }

  // Pack non éditable : le funnel propose la simulation. Session éphémère
  // minimale + pack en entrée ZIP + ouverture du simulateur (lecture seule).
  async function handleSimulatePackReady({ zipPath, packLabel }) {
    await prepareNewWorkSession('pack');
    store.addZip(null, zipPath, packLabel, null, null);
    setPendingSimulateZip(zipPath);
  }

  async function handleRecoverSession(recovery) {
    if (!recovery?.snapshotPath || !recovery?.sessionDir) return;
    try {
      const result = await loadProjectFromPath(recovery.snapshotPath);
      store.loadProject(result.data);
      store.setMediaTags(result.mediaTags ?? {});
      store.setSavePath(null);
      setMediaLibraryPaths(result.mediaLibraryPaths ?? []);
      savedSnapshotRef.current = null;
      autoSavePathRef.current = null;
      setAutoSavedPath(null);
      sessionModeRef.current = 'ephemeral';
      setSessionMode('ephemeral');
      setSessionWorkspaceDir(recovery.sessionDir);
      setWorkspaceDirState(recovery.sessionDir);
      workspaceDirRef.current = recovery.sessionDir;
      ephemeralSavedSnapshotRef.current = JSON.stringify(result.data);
      // Snapshot déjà sur disque : ne pas le réécrire immédiatement (le périodique suffit).
      ephemeralSnapshotSeededRef.current = true;
      sdStore.clearDone();
      xttsStore.clearDone();
      setSessionRecoveries((prev) => prev.filter((item) => item.sessionDir !== recovery.sessionDir));
      logger.info(`session:recovered path='${recovery.snapshotPath}'`);
    } catch (error) {
      logger.error('session:recover-error', error);
      showErrorDialog({
        title: 'Reprise impossible',
        message: `Impossible de reprendre cette session : ${error}`,
      });
    }
  }

  async function handleIgnoreSessionRecovery(recovery) {
    if (!recovery?.sessionDir) return;
    try {
      await invoke('cleanup_session_workspace', { path: recovery.sessionDir });
    } catch (error) {
      logger.warn('session:ignore-cleanup-error', error);
    }
    setSessionRecoveries((prev) => prev.filter((item) => item.sessionDir !== recovery.sessionDir));
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

  async function handleGenerate(projectOverride = null, { skipMetadata = false } = {}) {
    const projectForGeneration = projectOverride && !projectOverride?.preventDefault
      ? projectOverride
      : store.project;
    // Étape « métadonnées » avant de générer : on nomme/confirme le pack avant.
    // Éditeur libre (pack) : toujours. Mode simple : seulement si le nom d'export
    // n'est pas encore défini (comportement existant conservé pour ce premier tour).
    const isPack = projectForGeneration.projectType === 'pack';
    const isSimple = projectForGeneration.projectType === 'simple';
    const needsMetadataStep = !skipMetadata && (
      isPack
      || (isSimple && (!hasExplicitExportPackName(projectForGeneration) || importedPackPendingMetaRef.current))
    );
    if (needsMetadataStep) {
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

  async function handleSavePackMetadata(draft, { generate = false } = {}) {
    let effectiveDraft = draft;
    // Nouvelle révision d'un pack importé : proposer (sans obligation) un nouvel UUID
    // AVANT de générer — donc avant le sélecteur de dossier de sortie (dialogue natif
    // OS qui passe devant). Dialogue in-app awaitable, résolu ici puis on continue.
    if (generate && importedPackPendingMetaRef.current && isImportedOriginalUuid(draft)) {
      const choice = await showChoiceDialog({
        title: "Nouvelle révision d'un pack importé",
        message: "Ce pack a un UUID d'origine. Générer un nouvel UUID pour cette version ?\n\n"
          + "Garde l'UUID d'origine seulement pour remplacer exactement la même révision.",
        variant: 'info',
        cancelValue: 'keep',
        actions: [
          { value: 'keep', label: "Garder l'UUID d'origine", kind: 'ghost' },
          { value: 'renew', label: 'Générer un nouvel UUID', kind: 'primary', autoFocus: true },
        ],
      });
      if (choice === 'renew') effectiveDraft = { ...draft, uuid: generateUuid() };
    }
    const nextPackMetadata = { ...(store.project.packMetadata ?? {}), ...effectiveDraft };
    const isSimple = store.project.projectType === 'simple';
    const nextTitle = String(effectiveDraft?.title ?? '').trim();
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
    store.setProject(projectForAction);
    setPackMetadataOpen(false);
    // L'utilisateur a confirmé les métadonnées : ne plus reforcer la modal (D34).
    importedPackPendingMetaRef.current = false;
    // skipMetadata : on revient de la modale, on génère sans la rouvrir (évite la boucle).
    if (generate) await handleGenerate(projectForAction, { skipMetadata: true });
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

  const [importing, setImporting] = useState(null);
  const [unpacking, setUnpacking] = useState(null);

  // Tri des médias de session non utilisés à la promotion (plan 22, D51).
  const { triageSessionMedia, triageRequest } = useSessionMediaTriage({
    store,
    mediaLibraryPathsRef,
    setMediaLibraryPaths,
    showErrorDialog,
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
    triageSessionMedia: ({ project, savePath, targetWorkspaceDir }) => triageSessionMedia({
      project,
      sessionDir: sessionWorkspaceDir,
      targetWorkspaceDir,
      projectName: getProjectFilePrefix(project, savePath),
    }),
    onProjectSaved: async (_result, options = {}) => {
      // Seule la promotion « Enregistrer comme projet » (handleSaveProjectAs) nettoie
      // le dossier de session et bascule en mode projet. Un enregistrement en place
      // (handleSaveProject) ne doit JAMAIS supprimer la session éphémère en cours.
      if (!options.promote) return;
      if (sessionModeRef.current === 'ephemeral' && sessionWorkspaceDir && options.cleanupSession !== false) {
        invoke('cleanup_session_workspace', { path: sessionWorkspaceDir }).catch((error) => {
          logger.warn('session:cleanup-error', error);
        });
      }
      sessionModeRef.current = 'project';
      setSessionMode('project');
      setSessionWorkspaceDir('');
      if (options.workspaceDir) {
        setConfiguredWorkspaceDir(options.workspaceDir);
        setWorkspaceDirState(options.workspaceDir);
      }
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
    onProjectLoaded: async () => {
      const realWorkspace = configuredWorkspaceDir || await getWorkspaceDir();
      setSessionMode('project');
      setSessionWorkspaceDir('');
      setWorkspaceDirState(realWorkspace);
    },
    onBeforeProjectReplaced: async () => {
      if (sessionModeRef.current === 'ephemeral' && sessionWorkspaceDir) {
        await invoke('cleanup_session_workspace', { path: sessionWorkspaceDir }).catch((error) => {
          logger.warn('session:cleanup-error', error);
        });
      }
    },
  });

  // Plan 01 (révisé) : on ne propose plus d'enregistrer le projet source APRÈS
  // génération. La proposition ne subsiste qu'à la sortie de l'app / au remplacement
  // du travail courant (useWindowCloseGuard / useProjectLoading), jamais forcée.

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
    unpackZipIntoBlankProject,
    handleImportMediaLibrary,
    handleImportMediaLibraryFolder,
    handleImportMediaEpisodes,
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
    showErrorDialog,
    getImportDisplayName,
    isImportedPackPath,
    onImportedPackPromoted: () => { importedPackPendingMetaRef.current = true; },
  });

  async function handlePodcastFunnelImport(episodes, feed, onProgress) {
    const workspaceDir = await prepareNewWorkSession('pack');
    try {
      const feedTitle = String(feed?.title || '').trim();
      onProgress?.({ name: feedTitle || 'Podcast', index: 0, total: episodes.length, phase: 'Préparation de la session…' });
      let feedCover = null;
      if (feed?.imageUrl) {
        try {
          const tmpImage = await invoke('download_podcast_media', {
            url: feed.imageUrl,
            fileName: `${feedTitle || 'podcast'}-couverture`,
          });
          feedCover = await copyGeneratedMediaToProject(tmpImage);
        } catch (coverError) {
          logger.warn(`podcast-funnel:cover-error title='${feedTitle || 'Podcast'}' error=${coverError}`);
        }
      }
      if (feedTitle || feedCover) {
        store.setProject((project) => ({
          ...project,
          ...(feedTitle ? { projectName: feedTitle, rootName: feedTitle } : {}),
          ...(feedCover ? { rootImage: feedCover, thumbnailImage: feedCover } : {}),
          packMetadata: {
            ...(project.packMetadata ?? {}),
            ...(feedTitle ? { title: feedTitle } : {}),
          },
        }));
      }
      store.setSelectedId('root');
      const result = await handleImportMediaEpisodes(episodes, feed, {
        source: 'podcast',
        targetMenuId: null,
        onProgress,
        suppressDialog: true,
      });
      if (result.total > 0 && result.failures >= result.total) {
        throw new Error("Aucun épisode n'a pu être importé. Vérifie ta connexion ou l'adresse du flux RSS.");
      }
      if (result.failures > 0) {
        setImportNotice(`${result.failures} épisode(s) sur ${result.total} n'ont pas pu être importés. Les autres ont bien été ajoutés.`);
      }
      logger.info(`podcast-funnel:landed count=${result.imported}`);
    } catch (error) {
      logger.error('podcast-funnel:import-error', error);
      if (!useWorkspaceForNewProjects && workspaceDir) {
        invoke('cleanup_session_workspace', { path: workspaceDir }).catch(() => {});
      }
      store.resetProject();
      setSessionMode(null);
      setSessionWorkspaceDir('');
      setWorkspaceDirState(configuredWorkspaceDir);
      workspaceDirRef.current = configuredWorkspaceDir;
      throw error;
    }
  }

  // Funnel YouTube depuis l'accueil (plan 09) : jumeau de handlePodcastFunnelImport.
  // Crée la session éphémère, pré-remplit titre + vignette depuis la source, puis
  // importe les vidéos en histoires (source yt-dlp) avant l'atterrissage éditeur.
  async function handleYoutubeFunnelImport(videos, list, onProgress) {
    const workspaceDir = await prepareNewWorkSession('pack');
    try {
      const listTitle = String(list?.title || '').trim();
      onProgress?.({ name: listTitle || 'YouTube', index: 0, total: videos.length, phase: 'Préparation de la session…' });
      let listCover = null;
      if (list?.imageUrl) {
        try {
          const tmpImage = await invoke('download_podcast_media', {
            url: list.imageUrl,
            fileName: `${listTitle || 'youtube'}-couverture`,
          });
          listCover = await copyGeneratedMediaToProject(tmpImage);
        } catch (coverError) {
          logger.warn(`youtube-funnel:cover-error title='${listTitle || 'YouTube'}' error=${coverError}`);
        }
      }
      if (listTitle || listCover) {
        store.setProject((project) => ({
          ...project,
          ...(listTitle ? { projectName: listTitle, rootName: listTitle } : {}),
          ...(listCover ? { rootImage: listCover, thumbnailImage: listCover } : {}),
          packMetadata: {
            ...(project.packMetadata ?? {}),
            ...(listTitle ? { title: listTitle } : {}),
          },
        }));
      }
      store.setSelectedId('root');
      const result = await handleImportMediaEpisodes(videos, list, {
        source: 'youtube',
        targetMenuId: null,
        onProgress,
        suppressDialog: true,
      });
      if (result.total > 0 && result.failures >= result.total) {
        throw new Error("Aucune vidéo n'a pu être importée. Vérifie ta connexion ou l'adresse YouTube.");
      }
      if (result.failures > 0) {
        setImportNotice(`${result.failures} vidéo(s) sur ${result.total} n'ont pas pu être importées. Les autres ont bien été ajoutées.`);
      }
      logger.info(`youtube-funnel:landed count=${result.imported}`);
    } catch (error) {
      logger.error('youtube-funnel:import-error', error);
      if (!useWorkspaceForNewProjects && workspaceDir) {
        invoke('cleanup_session_workspace', { path: workspaceDir }).catch(() => {});
      }
      store.resetProject();
      setSessionMode(null);
      setSessionWorkspaceDir('');
      setWorkspaceDirState(configuredWorkspaceDir);
      workspaceDirRef.current = configuredWorkspaceDir;
      throw error;
    }
  }

  // Import YouTube depuis l'éditeur libre (plan 09) : pas de nouvelle session, on
  // insère dans le projet courant (cible déduite de la sélection comme les autres
  // imports média). Lève en cas d'échec total → écran d'erreur du funnel.
  async function handleYoutubeEditorImport(videos, list, onProgress) {
    const result = await handleImportMediaEpisodes(videos, list, {
      source: 'youtube',
      onProgress,
      suppressDialog: true,
    });
    if (result.total > 0 && result.failures >= result.total) {
      throw new Error("Aucune vidéo n'a pu être importée. Vérifie ta connexion ou l'adresse YouTube.");
    }
    if (result.failures > 0) {
      setImportNotice(`${result.failures} vidéo(s) sur ${result.total} n'ont pas pu être importées. Les autres ont bien été ajoutées.`);
    }
    logger.info(`youtube-editor:imported count=${result.imported}`);
  }

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

  const statusText = projectType === null ? 'Choisis un type de projet' : '';
  const projectDirty = savedSnapshotRef.current === null
    ? isProjectDirty(store.project)
    : JSON.stringify(store.project) !== savedSnapshotRef.current;
  const titleBarName = store.project.projectName?.trim() || null;
  const canImportStories = (store.activeTab === 'edit' || store.activeTab === 'diagram') && store.project.projectType === 'pack';
  const canAddFolder = canImportStories;
  const canRecord = canImportStories;
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
    openPreferences: () => setPrefsModalOpen(true),
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
      onImportFile: maybeCopyToProject,
      onExtractAudioEmbeddedImage: extractAudioEmbeddedImage,
      onSave: handleSaveProject,
      onOpenSDGenerate: handleOpenSDGenerate,
      onRemoveSdResult: sdStore.removeResult,
      onUpdateXttsSettings: handleUpdateXttsSettings,
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
        hasSavePath={!!store.savePath}
        saveState={saveToast}
        showProjectMeta={projectType !== null}
        onOpenPackMetadata={projectType !== null ? () => setPackMetadataOpen(true) : null}
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
          activeTab={store.activeTab}
          onActiveTabChange={store.setActiveTab}
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
            if (store.activeTab === 'diagram') {
              setDiagramInspectRequest({ id, nonce: Date.now() });
              return;
            }
            store.setActiveTab('edit');
          }}
        />
      )}

      <div className="chrome-shell">
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
              onImportPodcast={() => setPodcastImportOpen(true)}
              onImportYoutube={() => setYoutubeFunnelMode('editor')}
              onRecord={handleToolbarRecord}
              canRecord={canRecord}
              onUnpackZip={handleUnpackZip}
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
              onFocusTreeSearch={() => setTreeSearchFocusTrigger((n) => n + 1)}
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
              onImportFolder={handleImportFolder}
              onImportPodcast={() => setPodcastImportOpen(true)}
              onImportYoutube={() => setYoutubeFunnelMode('editor')}
              onRecord={handleToolbarRecord}
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

      {packMetadataOpen && renderDeferred(
        <PackNameModal
          open={packMetadataOpen}
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
