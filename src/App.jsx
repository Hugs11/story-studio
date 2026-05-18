import { Suspense, lazy, useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { open as openDialog, ask } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { sanitizeImportedEntries, sanitizeImportedName, useProjectStore } from './store/projectStore';
import {
  saveProject,
  saveProjectAs,
  loadProject,
  loadProjectFromPath,
  getRecentProjects,
  rememberRecentProject,
  forgetRecentProject,
  getExtractedZipsDir,
  ensureExportsDir,
  getWorkspaceDir,
  pickWorkspaceDir,
  copyMediaToWorkspace,
  isAlreadyManagedFile,
  consolidateProject,
  collectTransferableProjectFiles,
  transferProjectFilesToProject,
  autoSaveNewProject,
} from './store/projectIO';
import { getLastExportDir, saveLastExportDir, pickMultipleAudioOrZip, pickMultipleMediaFiles, pickFolder } from './store/useFileDialog';
import { ProjectContext } from './store/ProjectContext';
import { getGenerateErrors } from './store/projectValidation';
import { collectMediaLibrary } from './store/mediaLibrary';
import { buildProjectIndex, collectProjectAudioPaths, replaceEntryWithEntries, visitProjectEntries } from './store/projectModel';
import { loadXttsSettings, saveXttsSettings } from './store/xttsSettings';
import { useSdStore } from './store/sdStore';
import { useXttsStore } from './store/xttsStore';
import { useRenderQueueStore } from './store/renderQueueStore';
import { useRenderQueueExecutor } from './store/useRenderQueueExecutor';
import { useProjectFileAudit } from './store/useProjectFileAudit';
import { useProjectDerivedData } from './store/useProjectDerivedData';
import {
  findShortcutAction,
  getShortcutLabelMap,
  loadKeyboardShortcuts,
  saveKeyboardShortcuts,
} from './store/keyboardShortcuts';
import { applyThemePreference, loadThemePreference, saveThemePreference } from './store/themePreference';
import { Loader2, TriangleAlert } from './components/icons/LucideLocal';
import { TitleBar } from './components/layout/TitleBar';
import { Toolbar } from './components/layout/Toolbar';
import { PanelRail } from './components/layout/PanelRail';
import { BottomWorkspacePanel } from './components/BottomWorkspacePanel/BottomWorkspacePanel';
import { useEscapeKey } from './hooks/useEscapeKey';
import { useSDJobs } from './hooks/useSDJobs';
import { useXttsJobs } from './hooks/useXttsJobs';
import { logger } from './utils/logger';
import { isTauriRuntime } from './utils/tauriRuntime';
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
const StorySettingsModal = lazy(() => import('./components/StorySettingsModal/StorySettingsModal').then((module) => ({ default: module.StorySettingsModal })));
const RecordModal = lazy(() => import('./components/RecordModal/RecordModal').then((module) => ({ default: module.RecordModal })));

function renderDeferred(children, fallback = null) {
  return (
    <Suspense fallback={fallback}>
      {children}
    </Suspense>
  );
}

const APP_MODAL_OVERLAY_STYLE = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 10000,
  backdropFilter: 'blur(2px)',
};

function AppModalPortal({ className = 'modal-overlay', children }) {
  return createPortal(
    <div className={className} style={APP_MODAL_OVERLAY_STYLE}>
      {children}
    </div>,
    document.body,
  );
}

function isImportedPackPath(filePath) {
  return /\.(zip|7z)$/i.test(filePath || '');
}

function getImportDisplayName(filePath) {
  const fileName = String(filePath || '').split(/[\\/]/).pop() || '';
  return sanitizeImportedName(fileName, fileName || 'Import en cours');
}

function classifyOsDroppedFiles(paths) {
  const ext = (p) => (String(p).split('.').pop() || '').toLowerCase();
  const AUDIO = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'webm']);
  const IMAGES = new Set(['png', 'jpg', 'jpeg', 'webp']);
  const ARCHIVES = new Set(['zip', '7z']);
  return {
    audio: paths.filter((p) => AUDIO.has(ext(p))),
    images: paths.filter((p) => IMAGES.has(ext(p))),
    archives: paths.filter((p) => ARCHIVES.has(ext(p))),
  };
}

const AUDIO_ENTRY_FIELDS = ['audio', 'itemAudio', 'afterPlaybackPromptAudio'];
function mediaPathKey(path) {
  return String(path || '').replace(/^\\\\\?\\/, '').replace(/\\/g, '/').toLowerCase();
}

function markEntryAudioSkipSilence(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const audioProcessing = { ...(entry.audioProcessing ?? {}) };
  for (const field of AUDIO_ENTRY_FIELDS) {
    if (typeof entry[field] === 'string' && entry[field].trim()) {
      audioProcessing[field] = { skipSilence: true };
    }
  }
  const next = Object.keys(audioProcessing).length > 0
    ? { ...entry, audioProcessing }
    : { ...entry };
  if (Array.isArray(next.children)) {
    next.children = next.children.map(markEntryAudioSkipSilence);
  }
  return next;
}

function loadMediaLibraryPaths() {
  return [];
}

// Retourne true si le projet a du contenu (= mérite d'être sauvegardé)
function isProjectDirty(project) {
  if (project.projectType !== null) return true;
  let hasEntries = false;
  visitProjectEntries(project, (entry) => {
    if (entry.type === 'story' || entry.type === 'zip' || entry.type === 'menu') hasEntries = true;
  });
  return !!project.name || !!project.rootAudio || !!project.rootImage || hasEntries;
}

// Retourne true si on peut continuer (sauvegardé ou confirmé non-sauvegardé),
// false si l'utilisateur a annulé ou si la sauvegarde n'a pas abouti.
// savedSnapshot : JSON.stringify du projet au moment du dernier save/load, ou null si projet vierge
async function askSaveBeforeLeave(project, savedSnapshot, onSave) {
  // Si on a un snapshot, comparer pour détecter les vraies modifications
  // Si pas de snapshot (projet vierge), vérifier si le projet a du contenu
  const unchanged = savedSnapshot === null
    ? !isProjectDirty(project)
    : JSON.stringify(project) === savedSnapshot;
  if (unchanged) return true;
  // 1ère question : sauvegarder ?
  const save = await ask(
    'Voulez-vous sauvegarder le projet avant de continuer ?',
    { title: 'Projet non sauvegardé', kind: 'warning', okLabel: 'Sauvegarder', cancelLabel: 'Ne pas sauvegarder' }
  );
  if (save) {
    try {
      const savedPath = await onSave?.();
      return !!savedPath;
    } catch {
      return false;
    }
  }
  // 2ème question : vraiment continuer sans sauvegarder ?
  const discard = await ask(
    'Les modifications non sauvegardées seront perdues. Continuer quand même ?',
    { title: 'Continuer sans sauvegarder ?', kind: 'warning', okLabel: 'Continuer', cancelLabel: 'Annuler' }
  );
  return discard;
}

function SaveProgressModal({ data, title, doneTitle }) {
  return (
    <AppModalPortal>
      <div className="modal-box" style={{ width: 360 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {data.complete
              ? <>✓ {doneTitle}</>
              : <><Loader2 style={{ width: 14, height: 14, animation: 'spin 1s linear infinite' }} /> {title}</>}
          </span>
        </div>
        <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {data.lines.map((line, i) => {
            const isLast = i === data.lines.length - 1;
            const done = !isLast || data.complete;
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                {done
                  ? <span style={{ color: 'var(--color-accent)', width: 18, textAlign: 'center', flexShrink: 0, fontSize: 15 }}>✓</span>
                  : <span style={{
                      display: 'inline-block', width: 16, height: 16, flexShrink: 0,
                      border: '2px solid var(--color-border-secondary)',
                      borderTopColor: 'var(--color-accent)',
                      borderRadius: '50%',
                      animation: 'spin 0.7s linear infinite',
                    }} />
                }
                <span style={{
                  color: done ? 'var(--color-text-secondary)' : 'var(--color-text-primary)',
                  fontWeight: done ? 400 : 600,
                }}>
                  {line}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </AppModalPortal>
  );
}

export default function App() {
  const store = useProjectStore();
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
  const [bottomPanelOpen, setBottomPanelOpen] = useState(() => localStorage.getItem('bottomPanelOpen') === 'true');
  const [bottomPanelTab, setBottomPanelTab] = useState(() => localStorage.getItem('bottomPanelTab') || 'media');
  const [creditsOpen, setCreditsOpen] = useState(false);
  const [storySettingsOpen, setStorySettingsOpen] = useState(false);
  const [toolbarRecordOpen, setToolbarRecordOpen] = useState(false);
  const [copyImportedFilesEnabled, setCopyImportedFilesEnabled] = useState(() => localStorage.getItem('copyImportedFiles') === 'true');
  const [workspaceDir, setWorkspaceDirState] = useState(() => localStorage.getItem('storyStudioWorkspaceDir') || '');
  const [mediaLibraryPaths, setMediaLibraryPaths] = useState(() => loadMediaLibraryPaths());
  const [showWebmWarning, setShowWebmWarning] = useState(false);
  const [importNotice, setImportNotice] = useState(null); // string | null
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(() => localStorage.getItem('autoSaveEnabled') === 'true');
  const [autoSaveBackupLimit, setAutoSaveBackupLimit] = useState(() => {
    const raw = Number(localStorage.getItem('autoSaveBackupLimit'));
    return Number.isFinite(raw) && raw >= 0 ? raw : 5;
  });
  const [showCentralDiagram, setShowCentralDiagram] = useState(() => localStorage.getItem('showCentralDiagram') === 'true');
  const [prefsModalOpen, setPrefsModalOpen] = useState(false);
  const projectIndex = useMemo(() => buildProjectIndex(store.project), [store.project]);
  const { statusByPath: pathAudit, pending: pathAuditPending } = useProjectFileAudit(store.project, projectIndex);
  const mediaLibraryCount = useMemo(
    () => collectMediaLibrary({ project: store.project, statusByPath: pathAudit, sdJobs: sdStore.jobs, xttsJobs: xttsStore.jobs, extraPaths: mediaLibraryPaths }).length,
    [store.project, pathAudit, sdStore.jobs, xttsStore.jobs, mediaLibraryPaths],
  );
  const aiQueueActiveCount = sdStore.pendingCount + xttsStore.pendingCount;
  const aiQueueHasResults = sdStore.hasResults || xttsStore.hasResults;
  const projectRef = useRef(store.project);
  const savePathRef = useRef(store.savePath);
  const workspaceDirRef = useRef(localStorage.getItem('storyStudioWorkspaceDir') || '');
  const mediaTagsRef = useRef(store.mediaTags);
  const mediaLibraryPathsRef = useRef(mediaLibraryPaths);
  const mediaLibraryCountRef = useRef(0);
  const saveHandlerRef = useRef(null);
  const saveAsHandlerRef = useRef(null);
  const isSavingRef = useRef(false);
  const autoSavePathRef = useRef(null); // path of last autosave for never-manually-saved projects
  const shortcutActionsRef = useRef({});
  const keyboardShortcutsRef = useRef(keyboardShortcuts);
  const [treeSearchFocusTrigger, setTreeSearchFocusTrigger] = useState(0);
  const dismissedTransferPromptRef = useRef(null);
  // null = projet vierge (jamais sauvegardé/chargé) ; sinon JSON du projet au dernier save/load
  const savedSnapshotRef = useRef(null);

  useEffect(() => { getVersion().then(setAppVersion).catch(() => {}); }, []);
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
  mediaLibraryPathsRef.current = mediaLibraryPaths;
  mediaLibraryCountRef.current = mediaLibraryCount;

  useEffect(() => {
    workspaceDirRef.current = workspaceDir;
  }, [workspaceDir]);

  useEffect(() => {
    keyboardShortcutsRef.current = keyboardShortcuts;
    saveKeyboardShortcuts(keyboardShortcuts);
  }, [keyboardShortcuts]);

  useEffect(() => {
    applyThemePreference(themePreference);
    saveThemePreference(themePreference);
  }, [themePreference]);

  // Interception fermeture fenêtre — enregistré une seule fois
  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    const win = getCurrentWindow();
    let unlisten;
    win.onCloseRequested(async (e) => {
      e.preventDefault();
      const canClose = await askSaveBeforeLeave(projectRef.current, savedSnapshotRef.current, handleSaveProject);
      if (canClose) await win.destroy();
    }).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []); // eslint-disable-line

  useEffect(() => {
    localStorage.setItem('copyImportedFiles', String(copyImportedFilesEnabled));
    if (!copyImportedFilesEnabled) dismissedTransferPromptRef.current = null;
  }, [copyImportedFilesEnabled]);

  useEffect(() => {
    localStorage.setItem('autoSaveEnabled', String(autoSaveEnabled));
  }, [autoSaveEnabled]);

  useEffect(() => {
    localStorage.setItem('autoSaveBackupLimit', String(autoSaveBackupLimit));
  }, [autoSaveBackupLimit]);

  useEffect(() => {
    localStorage.setItem('showCentralDiagram', String(showCentralDiagram));
  }, [showCentralDiagram]);

  useEffect(() => {
    localStorage.setItem('bottomPanelOpen', String(bottomPanelOpen));
  }, [bottomPanelOpen]);

  useEffect(() => {
    localStorage.setItem('bottomPanelTab', bottomPanelTab);
  }, [bottomPanelTab]);

  useEffect(() => {
    if (renderQueue.panelOpen) {
      setBottomPanelOpen(true);
      setBottomPanelTab('queue');
      renderQueue.setPanelOpen(false);
    }
  }, [renderQueue.panelOpen]); // eslint-disable-line

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.target?.closest?.('.keyboard-shortcuts-modal')) return;
      if (document.querySelector('.audio-editor-modal')) return;

      const actions = shortcutActionsRef.current;
      const actionId = findShortcutAction(e, keyboardShortcutsRef.current);
      if (!actionId) return;
      const stopShortcut = () => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();
      };

      if (actionId === 'saveAs') {
        stopShortcut();
        saveAsHandlerRef.current?.();
        return;
      }

      if (actionId === 'saveProject') {
        stopShortcut();
        saveHandlerRef.current?.();
        return;
      }

      if (actionId === 'addFolder') {
        if (!actions.canAddFolder) return;
        stopShortcut();
        actions.addFolder?.();
        return;
      }

      if (actionId === 'newProject') {
        stopShortcut();
        actions.newProject?.();
        return;
      }

      if (actionId === 'openProject') {
        stopShortcut();
        actions.openProject?.();
        return;
      }

      if (actionId === 'importStories') {
        if (!actions.canImportStories) return;
        stopShortcut();
        actions.importStories?.();
        return;
      }

      if (actionId === 'storySettings') {
        if (!actions.projectActionsVisible) return;
        stopShortcut();
        actions.openStorySettings?.();
        return;
      }

      if (actionId === 'tabEdit') {
        if (!actions.projectActionsVisible) return;
        stopShortcut();
        actions.setActiveTab?.('edit');
        return;
      }

      if (actionId === 'tabEmulator') {
        if (!actions.projectActionsVisible) return;
        stopShortcut();
        actions.setActiveTab?.('emu');
        return;
      }

      if (actionId === 'tabDiagram') {
        if (!actions.projectActionsVisible) return;
        stopShortcut();
        actions.setActiveTab?.('diagram');
        return;
      }

      if (actionId === 'tabOptions') {
        if (!actions.projectActionsVisible) return;
        stopShortcut();
        actions.setActiveTab?.('opts');
        return;
      }

      if (actionId === 'generate') {
        if (!actions.canGenerate) return;
        stopShortcut();
        actions.generate?.();
        return;
      }

      if (actionId === 'treeSearch') {
        stopShortcut();
        if (!actions.projectActionsVisible || actions.activeTab !== 'edit') return;
        actions.focusTreeSearch?.();
      }
    }
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []); // eslint-disable-line

  useEffect(() => {
    if (!autoSaveEnabled) return;
    const interval = setInterval(async () => {
      if (isSavingRef.current) return;
      const current = JSON.stringify(projectRef.current);
      if (current === savedSnapshotRef.current) return;
      if (!isProjectDirty(projectRef.current)) {
        logger.warn('[autosave] projet vide détecté, sauvegarde automatique ignorée.');
        return;
      }
      if (!savePathRef.current) {
        // Project never manually saved — autosave to workspace/sauvegardes/ WITHOUT setting
        // store.savePath, so that recording/generation paths are never derived from the autosave file.
        const ws = workspaceDirRef.current || await getWorkspaceDir().catch(() => '');
        if (!ws) return;
        try {
          const existing = autoSavePathRef.current;
          if (existing) {
            await saveProject(projectRef.current, existing, null, {
              autosave: true,
              backupLimit: autoSaveBackupLimit,
              mediaTags: mediaTagsRef.current,
              mediaLibraryPaths: mediaLibraryPathsRef.current,
              totalMediaCount: mediaLibraryCountRef.current,
            });
            savedSnapshotRef.current = current;
            setAutoSavedPath(existing);
          } else {
            const result = await autoSaveNewProject(projectRef.current, ws, {
              backupLimit: autoSaveBackupLimit,
              mediaTags: mediaTagsRef.current,
              mediaLibraryPaths: mediaLibraryPathsRef.current,
              totalMediaCount: mediaLibraryCountRef.current,
            });
            if (!result?.path) return;
            autoSavePathRef.current = result.path;
            savedSnapshotRef.current = JSON.stringify(result.project);
            setAutoSavedPath(result.path);
          }
          setSaveToast('ok');
          setTimeout(() => setSaveToast(null), 2000);
        } catch (e) {
          logger.error('[autosave] échec de la sauvegarde automatique:', e);
        }
        return;
      }
      saveHandlerRef.current?.({ silent: true });
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [autoSaveEnabled, autoSaveBackupLimit]); // eslint-disable-line

  useEscapeKey(showWebmWarning, () => setShowWebmWarning(false));
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
      projectName: store.project.name || '',
      fieldId: sdGenerateContext?.fieldId || null,
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

  const getAudioJobUsage = useCallback((job) => {
    if (!job || job.kind !== 'audio' || job.status !== 'done' || !job.resultPath) return null;
    const normalizePath = (value) => String(value || '')
      .replace(/^\\\\\?\\/, '')
      .replace(/[\\/]+/g, '/')
      .trim()
      .toLowerCase();
    const audioFieldLabel = (field) => ({
      rootAudio: 'audio d’accueil',
      nightModeAudio: 'audio de fin',
      itemAudio: 'audio de sélection',
      audio: 'audio de lecture',
      afterPlaybackPromptAudio: 'audio après lecture',
      afterPlaybackSequence: 'audio de fin intermédiaire',
      afterPlaybackHomeStep: 'audio Home pendant lecture',
      coverAudio: 'audio de couverture',
    }[field] || 'champ audio');
    const resultPath = normalizePath(job.resultPath);
    const usages = [];

    function addUsage(path, nodeName, field) {
      if (path && normalizePath(path) === resultPath) {
        usages.push(`Nœud : ${nodeName} · Champ : ${audioFieldLabel(field)}`);
      }
    }

    addUsage(store.project?.rootAudio, store.project?.name || 'Accueil', 'rootAudio');
    addUsage(store.project?.nightModeAudio, 'Fin', 'nightModeAudio');

    for (const flatEntry of projectIndex.flatEntries ?? []) {
      const entry = flatEntry.entry ?? flatEntry;
      const nodeName = entry.name || (entry.type === 'menu' ? 'Menu sans titre' : entry.type === 'zip' ? 'ZIP sans titre' : 'Histoire sans titre');
      if (entry.type === 'menu') {
        addUsage(entry.audio, nodeName, 'audio');
      } else if (entry.type === 'story') {
        addUsage(entry.itemAudio, nodeName, 'itemAudio');
        addUsage(entry.audio, nodeName, 'audio');
        addUsage(entry.afterPlaybackPromptAudio, nodeName, 'afterPlaybackPromptAudio');
        for (const step of entry.afterPlaybackSequence ?? []) {
          addUsage(step.audio, nodeName, 'afterPlaybackSequence');
        }
        addUsage(entry.afterPlaybackHomeStep?.audio, nodeName, 'afterPlaybackHomeStep');
      } else if (entry.type === 'zip') {
        addUsage(entry.coverAudio, nodeName, 'coverAudio');
      }
    }

    if (usages.length > 0) {
      return {
        state: 'used',
        label: usages.length === 1 ? 'Utilisé' : `Utilisé ×${usages.length}`,
        detail: usages.join(' ; '),
      };
    }

    const target = job.target;
    let currentPath = null;
    let targetExists = true;
    let nodeName = null;
    let fieldLabel = audioFieldLabel(target?.field);

    switch (target?.kind) {
      case 'root':
        currentPath = store.project?.[target.field] ?? null;
        nodeName = store.project?.name || 'Accueil';
        break;
      case 'rootStory':
        currentPath = store.project?.rootEntries?.[0]?.[target.field] ?? null;
        nodeName = store.project?.rootEntries?.[0]?.name || 'Histoire principale';
        break;
      case 'menu': {
        const entry = projectIndex.entryById.get(target.entryId);
        targetExists = !!entry;
        currentPath = entry?.[target.field] ?? null;
        nodeName = entry?.name || 'Menu sans titre';
        break;
      }
      case 'story': {
        const entry = projectIndex.entryById.get(target.entryId);
        targetExists = !!entry;
        currentPath = entry?.[target.field] ?? null;
        nodeName = entry?.name || 'Histoire sans titre';
        break;
      }
      case 'storySequence': {
        const entry = projectIndex.entryById.get(target.entryId);
        const step = entry?.afterPlaybackSequence?.find((item) => item.id === target.stepId);
        targetExists = !!entry && !!step;
        currentPath = step?.[target.field] ?? null;
        nodeName = `${entry?.name || 'Histoire sans titre'} · ${step?.name || 'Sequence de fin'}`;
        fieldLabel = audioFieldLabel('afterPlaybackSequence');
        break;
      }
      case 'storyHomeStep': {
        const entry = projectIndex.entryById.get(target.entryId);
        targetExists = !!entry && !!entry.afterPlaybackHomeStep;
        currentPath = entry?.afterPlaybackHomeStep?.[target.field] ?? null;
        nodeName = `${entry?.name || 'Histoire sans titre'} · Home pendant lecture`;
        fieldLabel = audioFieldLabel('afterPlaybackHomeStep');
        break;
      }
      default:
        targetExists = false;
        break;
    }

    if (!targetExists) {
      return { state: 'unused', label: 'Non utilisé', detail: `${fieldLabel} n’existe plus` };
    }
    if (normalizePath(currentPath) === resultPath) {
      return { state: 'used', label: 'Utilisé', detail: `Nœud : ${nodeName} · Champ : ${fieldLabel}` };
    }
    return { state: 'unused', label: 'Non utilisé', detail: `Nœud : ${nodeName} · Champ modifié : ${fieldLabel}` };
  }, [projectIndex, store.project]);

  const getImageJobUsage = useCallback((job) => {
    if (!job || job.kind === 'audio' || job.status !== 'done' || !job.resultPaths?.length) return null;
    const normalizePath = (value) => String(value || '')
      .replace(/^\\\\\?\\/, '')
      .replace(/[\\/]+/g, '/')
      .trim()
      .toLowerCase();
    const resultSet = new Set(job.resultPaths.map(normalizePath));
    const usages = [];

    function addUsage(path, nodeName, fieldLabel) {
      if (path && resultSet.has(normalizePath(path))) {
        usages.push(`${nodeName} · ${fieldLabel}`);
      }
    }

    addUsage(store.project?.rootImage, store.project?.name || 'Accueil', 'image d’accueil');
    addUsage(store.project?.thumbnailImage, store.project?.name || 'Accueil', 'vignette');

    for (const flatEntry of projectIndex.flatEntries ?? []) {
      const entry = flatEntry.entry ?? flatEntry;
      const nodeName = entry.name || (entry.type === 'menu' ? 'Menu sans titre' : 'Histoire sans titre');
      addUsage(entry.image, nodeName, entry.type === 'menu' ? 'image du menu' : 'image de l’histoire');
      addUsage(entry.itemImage, nodeName, 'image de sélection');
      addUsage(entry.coverImage, nodeName, 'couverture');
    }

    if (usages.length > 0) {
      return {
        state: 'used',
        label: usages.length === 1 ? 'Utilisée' : `Utilisées ×${usages.length}`,
        detail: usages.join(' ; '),
      };
    }
    return { state: 'unused', label: 'Non utilisée', detail: 'Aucune image de cette génération n’est assignée au projet.' };
  }, [projectIndex, store.project]);

  async function handleQueueXttsGenerate(job) {
    xttsStore.addJob({
      label: job.targetLabel || 'Audio IA',
      targetLabel: job.targetLabel || 'Audio IA',
      voiceLabel: job.voiceLabel || 'XTTS',
      target: job.target || null,
      request: job.request,
      settings: { ...xttsSettings },
      projectName: store.project.name || '',
    });
    handleOpenAiQueue();
  }

  async function handleNewProject() {
    const canContinue = await askSaveBeforeLeave(store.project, savedSnapshotRef.current, handleSaveProject);
    if (!canContinue) return;
    store.resetProject();
    setMediaLibraryPaths([]);
    savedSnapshotRef.current = null;
    autoSavePathRef.current = null;
    setAutoSavedPath(null);
    sdStore.clearDone();
    xttsStore.clearDone();
    // Effacer les champs spécifiques au projet (titre, bonus, producteur) dans la convention de nommage
    try {
      const saved = JSON.parse(localStorage.getItem('nameGenFields') || '{}');
      localStorage.setItem('nameGenFields', JSON.stringify({ ...saved, title: '', bonus: '', producer: '' }));
    } catch {}
  }

  async function handleGenerate() {
    if (pathAuditPending) {
      alert('Vérification des fichiers du projet en cours. Attendez une seconde puis réessayez.');
      return;
    }
    const validationErrors = getGenerateErrors(store.project, pathAudit);
    if (validationErrors.length > 0) {
      alert(`Impossible de générer le pack :\n\n• ${validationErrors.join('\n• ')}`);
      return;
    }
    let defaultPath = getLastExportDir();
    if (!defaultPath) {
      const ws = workspaceDirRef.current || localStorage.getItem('storyStudioWorkspaceDir') || '';
      if (ws) {
        const exportsDir = await ensureExportsDir(ws);
        if (exportsDir) defaultPath = exportsDir;
      }
    }
    const outputFolder = await openDialog({ directory: true, multiple: false, title: 'Dossier de sortie du pack', defaultPath });
    if (!outputFolder) return;
    saveLastExportDir(outputFolder);
    renderQueue.addJob({
      projectName: store.project.name || '(sans nom)',
      savePath: store.savePath ?? null,
      projectJson: JSON.stringify(store.project),
      outputFolder,
    });
  }

  const handleUpdateRoot = useCallback(({ name, rootName, packVersion, packDescription, packMinAge }) => {
    if (name !== undefined) store.updateProjectName(name);
    if (rootName !== undefined || packVersion !== undefined || packDescription !== undefined || packMinAge !== undefined) {
      store.setProject(p => ({
        ...p,
        ...(rootName !== undefined ? { rootName } : {}),
        ...(packVersion !== undefined ? { packVersion } : {}),
        ...(packDescription !== undefined ? { packDescription } : {}),
        ...(packMinAge !== undefined ? { packMinAge } : {}),
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

  async function maybeCopyToProject(filePath) {
    if (!copyImportedFilesEnabled) return filePath;
    const ws = workspaceDirRef.current || localStorage.getItem('storyStudioWorkspaceDir') || '';
    if (isAlreadyManagedFile(filePath, ws, savePathRef.current)) return filePath;
    try {
      const targetWorkspace = ws || await getWorkspaceDir();
      if (!workspaceDir) setWorkspaceDirState(targetWorkspace);
      return await copyMediaToWorkspace(filePath, targetWorkspace, 'fichiers-importes', store.project.name);
    } catch (e) {
      logger.error('[maybeCopyToProject] échec copie:', e);
      return filePath;
    }
  }

  // Drop/paste audio from MediaExplorer onto a tree or diagram node.
  const mediaDropNodeHandlerRef = useRef(null);
  mediaDropNodeHandlerRef.current = async ({ nodeId, nodeType, path, paths, kind, clipboardMode }) => {
    if (kind !== 'audio' && kind !== 'image') return;
    const sourcePaths = (Array.isArray(paths) && paths.length > 0 ? paths : [path]).filter(Boolean);
    if (sourcePaths.length === 0) return;
    const finalPaths = [];
    for (const sourcePath of sourcePaths) {
      finalPaths.push(await maybeCopyToProject(sourcePath));
    }
    if (clipboardMode === 'cut') {
      for (const sourcePath of sourcePaths) {
        store.removeMediaReferences(sourcePath);
      }
    }
    if (kind === 'image') {
      const finalPath = finalPaths[0];
      if (nodeType === 'root') {
        store.updateRootMedia('rootImage', finalPath);
      } else if (nodeType === 'menu') {
        store.updateMenu(nodeId, { image: finalPath });
      } else if (nodeType === 'story') {
        store.updateItem(nodeId, { itemImage: finalPath });
      }
      return;
    }
    if (nodeType === 'root') {
      for (const finalPath of finalPaths) {
        store.addStory(null, finalPath);
      }
    } else if (nodeType === 'menu') {
      for (const finalPath of finalPaths) {
        store.addStory(nodeId, finalPath);
      }
    } else if (nodeType === 'story') {
      store.updateItem(nodeId, { audio: finalPaths[0] });
    }
  };
  useEffect(() => {
    function onDrop(e) {
      void mediaDropNodeHandlerRef.current(e.detail);
    }
    document.addEventListener('media-drop-node', onDrop);
    return () => document.removeEventListener('media-drop-node', onDrop);
  }, []);

  const mediaCutPasteHandlerRef = useRef(null);
  mediaCutPasteHandlerRef.current = ({ path }) => {
    store.removeMediaReferences(path);
  };
  useEffect(() => {
    function onCutPaste(e) {
      mediaCutPasteHandlerRef.current(e.detail);
    }
    document.addEventListener('media-clipboard-cut-paste', onCutPaste);
    return () => document.removeEventListener('media-clipboard-cut-paste', onCutPaste);
  }, []);

  const handleDeleteMedia = useCallback(async (item, { deleteFromDisk = false } = {}) => {
    if (!item?.path) return { diskDeleted: false, diskError: null };
    if (item.inProject) {
      store.removeMediaReferences(item.path);
    }

    const key = mediaPathKey(item.path);
    setMediaLibraryPaths((previous) => previous.filter((path) => mediaPathKey(path) !== key));
    for (const job of xttsStore.jobs) {
      if (mediaPathKey(job?.resultPath) === key) xttsStore.removeJob(job.id);
    }
    for (const job of sdStore.jobs) {
      if (!(job?.resultPaths ?? []).some((path) => mediaPathKey(path) === key)) continue;
      const nextPaths = job.resultPaths.filter((path) => mediaPathKey(path) !== key);
      if (nextPaths.length === 0) sdStore.removeJob(job.id);
      else sdStore.updateJob(job.id, { resultPaths: nextPaths });
    }
    store.deleteMediaTagsForPath(item.path);
    if (!deleteFromDisk) {
      return { diskDeleted: false, diskError: null };
    }
    const workspace = workspaceDirRef.current || '';
    try {
      await invoke('delete_workspace_media_file', { path: item.path, workspaceDir: workspace });
      return { diskDeleted: true, diskError: null };
    } catch (error) {
      const message = typeof error === 'string' ? error : (error?.message || String(error));
      return { diskDeleted: false, diskError: message };
    }
  }, [sdStore, store, xttsStore]);

  function addPathsToMediaLibrary(paths) {
    setMediaLibraryPaths((previous) => {
      const seen = new Set(previous.map((path) => path.replace(/\\/g, '/').toLowerCase()));
      const merged = [...previous];
      for (const path of paths) {
        const key = path.replace(/\\/g, '/').toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(path);
        }
      }
      return merged;
    });
  }

  async function handleImportMediaLibrary() {
    const files = await pickMultipleMediaFiles();
    if (files.length === 0) return;
    const total = files.length;
    setImporting({ name: files[0].split(/[\\/]/).pop() || files[0], index: 0, total, phase: "Préparation de l'import..." });
    try {
      const nextPaths = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setImporting({ name: file.split(/[\\/]/).pop() || file, index: i + 1, total, phase: 'Copie dans le projet...' });
        nextPaths.push(await maybeCopyToProject(file));
      }
      addPathsToMediaLibrary(nextPaths);
    } finally {
      setImporting(null);
    }
  }

  async function handleImportMediaLibraryFolder() {
    const folderPath = await pickFolder();
    if (!folderPath) return;
    try {
      const files = await invoke('list_folder_media_files', { folderPath });
      if (!files.length) return;
      const total = files.length;
      const folderName = folderPath.split(/[\\/]/).pop() || folderPath;
      setImporting({ name: folderName, index: 0, total, phase: 'Scan du dossier...' });
      const nextPaths = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const fileName = file.split(/[\\/]/).pop() || file;
        setImporting({ name: fileName, index: i + 1, total, phase: 'Copie dans le projet...' });
        nextPaths.push(await maybeCopyToProject(file));
      }
      addPathsToMediaLibrary(nextPaths);
    } catch (e) {
      logger.error('[handleImportMediaLibraryFolder] erreur:', e);
    } finally {
      setImporting(null);
    }
  }

  function handleMediaCreated(path) {
    if (!path) return;
    setMediaLibraryPaths((previous) => {
      const key = mediaPathKey(path);
      if (previous.some((existing) => mediaPathKey(existing) === key)) return previous;
      return [...previous, path];
    });
  }

  async function extractAudioEmbeddedImage(audioPath) {
    if (!audioPath) return null;
    try {
      return await invoke('extract_audio_embedded_image', { audioPath });
    } catch (e) {
      logger.warn('[extractAudioEmbeddedImage] extraction impossible:', audioPath, e);
      return null;
    }
  }

  function buildTransferPromptSignature(savePath, candidates) {
    return `${savePath}::${candidates.map((candidate) => candidate.path.toLowerCase()).sort().join('|')}`;
  }

  async function maybeOfferTransferIntoProject(project, savePath, options = {}) {
    const { forcePrompt = false, copyEnabled = copyImportedFilesEnabled } = options;
    if (!copyEnabled || !savePath) return { project, changed: false };

    const candidates = collectTransferableProjectFiles(project, savePath, pathAudit);
    if (candidates.length === 0) {
      dismissedTransferPromptRef.current = null;
      return { project, changed: false };
    }

    const signature = buildTransferPromptSignature(savePath, candidates);
    if (!forcePrompt && dismissedTransferPromptRef.current === signature) {
      return { project, changed: false };
    }

    const sample = candidates.slice(0, 5).map((candidate) => `• ${candidate.filename}`).join('\n');
    const suffix = candidates.length > 5 ? `\n• …et ${candidates.length - 5} autre(s)` : '';
    const confirmed = await ask(
      `${candidates.length} fichier(s) déjà liés au projet sont encore hors de l’emplacement de travail.\n\n${sample}${suffix}\n\nVoulez-vous les copier dans fichiers-importes/ et mettre à jour le projet ?`,
      {
        title: 'Transférer les fichiers existants ?',
        kind: 'warning',
        okLabel: 'Transférer',
        cancelLabel: 'Plus tard',
      }
    );

    if (!confirmed) {
      dismissedTransferPromptRef.current = signature;
      return { project, changed: false };
    }

    const transferResult = await transferProjectFilesToProject(
      project,
      savePath,
      async (sourcePath) => {
        const targetWorkspace = workspaceDir || await getWorkspaceDir();
        if (!workspaceDir) setWorkspaceDirState(targetWorkspace);
        return copyMediaToWorkspace(sourcePath, targetWorkspace, 'fichiers-importes', store.project.name);
      },
      pathAudit,
    );

    dismissedTransferPromptRef.current = null;

    if (transferResult.errors.length > 0) {
      const details = transferResult.errors
        .slice(0, 5)
        .map((error) => `• ${error.label}\n  ${error.error}`)
        .join('\n');
      alert(`Certains fichiers n'ont pas pu être transférés :\n\n${details}`);
    }

    return {
      project: transferResult.project,
      changed: transferResult.copiedCount > 0,
    };
  }

  async function persistProjectSnapshot(project, savePath) {
    const result = await saveProject(project, savePath);
    if (!result?.path) return null;
    store.syncProjectWithoutHistory(result.project);
    store.setSavePath(result.path);
    savedSnapshotRef.current = JSON.stringify(result.project);
    setSaveToast('ok');
    setTimeout(() => setSaveToast(null), 2000);
    return result.path;
  }

  async function handleCopyImportedFilesChange(enabled) {
    setCopyImportedFilesEnabled(enabled);
    if (!enabled || !store.savePath) return;

    try {
      const transferResult = await maybeOfferTransferIntoProject(store.project, store.savePath, {
        forcePrompt: true,
        copyEnabled: enabled,
      });
      if (transferResult.changed) {
        await persistProjectSnapshot(transferResult.project, store.savePath);
      }
    } catch (e) {
      logger.error('[handleCopyImportedFilesChange] erreur:', e);
      setSaveToast('error');
      setTimeout(() => setSaveToast(null), 3000);
    }
  }

  async function handlePickWorkspaceDir() {
    const chosen = await pickWorkspaceDir();
    if (chosen) setWorkspaceDirState(chosen);
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
        alert(`Projet consolidé avec des fichiers manquants :\n\n${result.errors.slice(0, 5).map((error) => `• ${error.path}\n  ${error.error}`).join('\n')}`);
      }
      return result;
    } catch (error) {
      setSaveProgress(null);
      alert(`Consolidation impossible : ${error}`);
      return null;
    }
  }

  const [importing, setImporting] = useState(null);
  const [unpacking, setUnpacking] = useState(null);
  const [saveAsProgress, setSaveAsProgress] = useState(null); // null | { lines: string[], complete: boolean }
  const [saveProgress, setSaveProgress] = useState(null); // null | { lines: string[], complete: boolean }
  const osDropScaleFactorRef = useRef(typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1);

  async function dispatchFiles(menuId, files) {
    for (let index = 0; index < files.length; index += 1) {
      const f = files[index];
      const displayName = getImportDisplayName(f);
      setImporting({
        name: displayName,
        index: index + 1,
        total: files.length,
        phase: isImportedPackPath(f)
          ? "Analyse du pack importé..."
          : "Import de l'audio...",
      });

      const file = await maybeCopyToProject(f);
      if (isImportedPackPath(file)) {
        let zipTitle = null;
        let zipCoverImage = null;
        let zipCoverAudio = null;
        try {
          setImporting({
            name: displayName,
            index: index + 1,
            total: files.length,
            phase: 'Lecture des métadonnées du pack...',
          });
          const json = await invoke('load_pack_zip', { zipPath: file });
          const data = JSON.parse(json);
          zipTitle = sanitizeImportedName(data.title?.trim(), null);
          const sq = (data.stageNodes || []).find(n => n.squareOne === true);
          zipCoverImage = sq?.image || null;
          zipCoverAudio = sq?.audio || null;
        } catch (e) {
          alert(`Archive importée invalide ou inaccessible : ${file}\n\n${e}`);
          continue;
        }
        store.addZip(menuId, file, zipTitle, zipCoverImage, zipCoverAudio);
      } else {
        setImporting({
          name: displayName,
          index: index + 1,
          total: files.length,
          phase: "Analyse de l'audio importé...",
        });
        const embeddedImage = await extractAudioEmbeddedImage(file);
        const storyId = store.addStory(menuId, file);
        if (embeddedImage) store.updateItem(storyId, { itemImage: embeddedImage });
      }
    }
  }

  const handleAddStory = useCallback(async () => {
    const files = await pickMultipleAudioOrZip();
    if (files.length === 0) return;
    setImporting({
      name: getImportDisplayName(files[0]),
      index: 0,
      total: files.length,
      phase: "Préparation de l'import...",
    });
    try {
      await dispatchFiles(null, files);
    } finally {
      setImporting(null);
    }
  }, [dispatchFiles, setImporting]);

  const handleAddStoryToMenu = useCallback(async (menuId) => {
    const files = await pickMultipleAudioOrZip();
    if (files.length === 0) return;
    setImporting({
      name: getImportDisplayName(files[0]),
      index: 0,
      total: files.length,
      phase: "Préparation de l'import...",
    });
    try {
      await dispatchFiles(menuId ?? null, files);
    } finally {
      setImporting(null);
    }
  }, [dispatchFiles, setImporting]);

  // OS file drop — fichiers glissés depuis l'explorateur Windows
  const osFileDropHandlerRef = useRef(null);
  osFileDropHandlerRef.current = async ({ type, paths, position }) => {
    const cssPosition = position
      ? {
          x: position.x / (osDropScaleFactorRef.current || 1),
          y: position.y / (osDropScaleFactorRef.current || 1),
        }
      : null;
    if (type === 'over' && position) {
      const el = document.elementFromPoint(cssPosition.x, cssPosition.y);
      const zone = el?.closest('[data-os-drop-zone]')?.dataset?.osDropZone ?? null;
      document.dispatchEvent(new CustomEvent('os-file-drag-zone', { detail: { zone } }));
      return;
    }
    if (type === 'cancel' || type === 'leave') {
      document.dispatchEvent(new CustomEvent('os-file-drag-zone', { detail: { zone: null } }));
      return;
    }
    if (type === 'drop') {
      document.dispatchEvent(new CustomEvent('os-file-drag-zone', { detail: { zone: null } }));
      if (!paths?.length || !cssPosition) return;
      const el = document.elementFromPoint(cssPosition.x, cssPosition.y);
      const zone = el?.closest('[data-os-drop-zone]')?.dataset?.osDropZone ?? null;
      if (!zone) return;
      const { audio, images, archives } = classifyOsDroppedFiles(paths);
      if (zone === 'treepanel') {
        const relevant = [...audio, ...archives];
        if (relevant.length === 0) return;
        setImporting({ name: getImportDisplayName(relevant[0]), index: 0, total: relevant.length, phase: "Préparation de l'import..." });
        try {
          await dispatchFiles(null, relevant);
        } finally {
          setImporting(null);
        }
      } else if (zone === 'mediaexplorer') {
        const relevant = [...audio, ...images, ...archives];
        if (relevant.length === 0) return;
        const total = relevant.length;
        setImporting({ name: getImportDisplayName(relevant[0]), index: 0, total, phase: "Préparation de l'import..." });
        try {
          const nextPaths = [];
          for (let i = 0; i < relevant.length; i++) {
            const file = relevant[i];
            setImporting({ name: getImportDisplayName(file), index: i + 1, total, phase: 'Copie dans le projet...' });
            nextPaths.push(await maybeCopyToProject(file));
          }
          addPathsToMediaLibrary(nextPaths);
        } finally {
          setImporting(null);
        }
      }
    }
  };
  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    let unlisten;
    let cancelled = false;
    const win = getCurrentWindow();
    win.scaleFactor()
      .then((factor) => {
        if (!cancelled && Number.isFinite(factor) && factor > 0) {
          osDropScaleFactorRef.current = factor;
        }
      })
      .catch(() => {});
    win.onDragDropEvent((event) => osFileDropHandlerRef.current(event.payload))
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((error) => logger.error('[os-file-drop] écoute impossible:', error));
    return () => {
      cancelled = true;
      unlisten?.();
      document.dispatchEvent(new CustomEvent('os-file-drag-zone', { detail: { zone: null } }));
    };
  }, []);

  function countFolderFiles(node) {
    if (node.type === 'folder') return (node.children ?? []).reduce((s, c) => s + countFolderFiles(c), 0);
    return 1;
  }

  async function processFolderNode(node, parentMenuId, counter, total) {
    if (node.type === 'folder') {
      const menuId = store.addMenu(parentMenuId);
      store.updateMenu(menuId, { name: node.name });
      for (const child of (node.children ?? [])) {
        await processFolderNode(child, menuId, counter, total);
      }
    } else if (node.type === 'audio') {
      counter.value += 1;
      setImporting({ name: node.name, index: counter.value, total, phase: "Import de l'audio..." });
      const copiedPath = await maybeCopyToProject(node.path);
      const embeddedImage = await extractAudioEmbeddedImage(copiedPath);
      const storyId = store.addStory(parentMenuId, copiedPath);
      if (embeddedImage) store.updateItem(storyId, { itemImage: embeddedImage });
    } else if (node.type === 'zip') {
      counter.value += 1;
      setImporting({ name: node.name, index: counter.value, total, phase: "Import de l'archive..." });
      const copiedPath = await maybeCopyToProject(node.path);
      store.addZip(parentMenuId, copiedPath, null, null, null);
    }
  }

  async function handleImportFolder(targetMenuId = null) {
    const folderPath = await pickFolder();
    if (!folderPath) return;
    let tree;
    try {
      tree = await invoke('scan_import_folder', { folderPath });
    } catch (e) {
      alert(`Impossible de lire le dossier : ${e}`);
      return;
    }
    const total = countFolderFiles(tree);
    if (total === 0) {
      alert('Aucun fichier audio ou archive trouvé dans ce dossier.');
      return;
    }
    setImporting({ name: tree.name, index: 0, total, phase: 'Analyse du dossier...' });
    try {
      await processFolderNode(tree, targetMenuId, { value: 0 }, total);
    } finally {
      setImporting(null);
    }
  }

  async function handleUnpackZip(itemId) {
    const zipItem = projectIndex.entryById.get(itemId) ?? null;
    if (!zipItem?.zipPath) return;
    const menuId = projectIndex.parentMenuById.get(itemId) ?? null;

    let effectiveSavePath = store.savePath;
    if (!effectiveSavePath) {
      const path = await handleSaveProject();
      if (!path) return;
      effectiveSavePath = path;
    }

    const skipSilenceForExtractedAudio = await ask(
      "Les audios d'un pack extrait contiennent souvent déjà leurs silences de début/fin. Voulez-vous exclure les audios extraits de l'ajout de silence global ?",
      {
        title: 'Extraction du pack',
        kind: 'info',
        okLabel: 'Exclure du silence',
        cancelLabel: 'Garder le traitement global',
      }
    );

    setUnpacking({ name: zipItem.name || 'ZIP en cours' });
    try {
      const extractedDirName = sanitizeImportedName(zipItem.name || itemId, itemId).replace(/[/\\:*?"<>|]/g, '_');
      const wsDir = workspaceDirRef.current || localStorage.getItem('storyStudioWorkspaceDir') || effectiveSavePath.replace(/[\\/][^\\/]+$/, '');
      const destDir = getExtractedZipsDir(wsDir) + '/' + extractedDirName;
      const result = await invoke('unpack_zip_to_entries', {
        zipPath: zipItem.zipPath,
        destDir,
        workspaceDir: wsDir,
      });
      const entries = sanitizeImportedEntries(result?.entries ?? []);
      if (!entries.length) {
        alert('Aucune entrée trouvée dans ce ZIP.');
        return;
      }

      const processedEntries = (skipSilenceForExtractedAudio
        ? entries.map(markEntryAudioSkipSilence)
        : entries);
      const zipFilename = (zipItem.zipPath || '').split(/[\\/]/).pop().replace(/\.(zip|7z)$/i, '');
      const isZipConvention = /^\d+\+\]/.test(zipFilename);
      const isTitleConvention = /^\d+\+\]/.test(result?.title || '');
      const packName = (result?.title && (isTitleConvention || !isZipConvention))
        ? sanitizeImportedName(result.title, zipItem.name || 'Pack importé')
        : sanitizeImportedName(zipFilename || zipItem.name, 'Pack importé');
      const zipAgeMatch = (zipFilename || zipItem.name || '').match(/^(\d+)\+\]/);
      const packMinAge = zipAgeMatch ? zipAgeMatch[1] : '';
      const isBlankProject = menuId == null
        && (store.project.rootEntries ?? []).length === 1
        && !store.project.name
        && !store.project.rootAudio
        && !store.project.rootImage;
      let nextProject = isBlankProject
        ? {
            ...store.project,
            projectType: 'pack',
            name: packName,
            packVersion: result?.packVersion ?? 1,
            packDescription: result?.packDescription ?? '',
            packMinAge,
            packConventionSource: isZipConvention ? zipFilename : '',
            rootAudio: result?.rootAudio ?? null,
            rootImage: result?.rootImage ?? null,
            thumbnailImage: result?.thumbnailImage ?? result?.rootImage ?? null,
            sameImage: !!(result?.rootImage) && !result?.thumbnailImage,
            nativeGraph: result?.nativeGraph ?? null,
            rootEntries: processedEntries,
          }
        : replaceEntryWithEntries(store.project, menuId, itemId, processedEntries);
      const unresolvedTransitions = Array.isArray(result?.unresolvedTransitions)
        ? result.unresolvedTransitions.map((warning) => ({
            ...warning,
            sourceRootId: result?.rootId ?? null,
            sourceName: packName,
          }))
        : [];
      nextProject = {
        ...nextProject,
        importWarnings: [
          ...(nextProject.importWarnings ?? []).filter((warning) => warning?.sourceRootId !== result?.rootId),
          ...unresolvedTransitions,
        ],
      };
      if (result?.nightMode && result?.nightModeAudio && !nextProject.globalOptions?.nightMode) {
        nextProject = {
          ...nextProject,
          nightModeAudio: result.nightModeAudio,
          nightModeReturn: result.nightModeReturn ?? null,
          nightModeHomeReturn: result.nightModeHomeReturn ?? null,
          audioProcessing: skipSilenceForExtractedAudio
            ? {
                ...(nextProject.audioProcessing ?? {}),
                nightModeAudio: { skipSilence: true },
              }
            : nextProject.audioProcessing,
          globalOptions: {
            ...nextProject.globalOptions,
            nightMode: true,
          },
        };
      }
      store.setProject(nextProject);
      store.setSelectedId('root');
      await persistProjectSnapshot(nextProject, effectiveSavePath);
      if (result?.advancedTransitionsDetected) {
        const firstWarning = unresolvedTransitions[0]?.message;
        setImportNotice(
          "Certaines transitions du pack importé n'ont pas pu être modélisées complètement. "
          + "Story Studio a conservé la structure reconnue, mais vérifiez les retours concernés avant export."
          + (firstWarning ? ` Exemple : ${firstWarning}` : '')
        );
      }
    } catch (e) {
      alert(`Erreur lors de l'extraction : ${e}`);
    } finally {
      setUnpacking(null);
    }
  }

  async function handleSave() {
    return handleSaveProject();
  }

  async function handleSaveProject({ silent = false } = {}) {
    if (isSavingRef.current) return null;
    isSavingRef.current = true;
    let progressStarted = false;
    function onProgress(step) {
      if (silent) return;
      if (!progressStarted) {
        progressStarted = true;
        setSaveProgress({ lines: [step], complete: false });
      } else {
        setSaveProgress(prev => prev ? { ...prev, lines: [...prev.lines, step] } : { lines: [step], complete: false });
      }
    }
    try {
      let result = await saveProject(store.project, store.savePath, onProgress, {
        autosave: silent,
        backupLimit: autoSaveEnabled ? autoSaveBackupLimit : 0,
        mediaTags: store.mediaTags,
        mediaLibraryPaths: mediaLibraryPathsRef.current,
        workspaceDir: workspaceDirRef.current,
      });
      if (!result) {
        setSaveProgress(null);
        return null;
      }
      if (result?.path) {
        const transferResult = silent
          ? { project: result.project, changed: false }
          : await maybeOfferTransferIntoProject(result.project, result.path);
        if (transferResult.changed) {
          result = await saveProject(transferResult.project, result.path, onProgress, { mediaTags: store.mediaTags });
        }
        store.syncProjectWithoutHistory(result.project);
        store.setSavePath(result.path);
        setRecentProjects(rememberRecentProject(result.project, result.path));
        savedSnapshotRef.current = JSON.stringify(result.project);
        if (!silent) {
          setSaveProgress(prev => prev ? { ...prev, complete: true } : null);
          setTimeout(() => setSaveProgress(null), 1500);
        }
        setSaveToast('ok');
        setTimeout(() => setSaveToast(null), 2000);
        return result.path;
      }
      setSaveProgress(null);
      return null;
    } catch (e) {
      logger.error('[handleSave] erreur:', e);
      setSaveProgress(null);
      setSaveToast('error');
      setTimeout(() => setSaveToast(null), 3000);
      return null;
    } finally {
      isSavingRef.current = false;
    }
  }

  async function handleSaveProjectAs() {
    let progressStarted = false;
    function onProgress(step) {
      if (!progressStarted) {
        progressStarted = true;
        setSaveAsProgress({ lines: [step], complete: false });
      } else {
        setSaveAsProgress(prev => prev ? { ...prev, lines: [...prev.lines, step] } : { lines: [step], complete: false });
      }
    }
    try {
      const result = await saveProjectAs(store.project, store.savePath, onProgress, store.mediaTags, { workspaceDir: workspaceDirRef.current }, mediaLibraryPathsRef.current);
      if (!result) {
        setSaveAsProgress(null);
        return null;
      }
      if (result?.path) {
        store.syncProjectWithoutHistory(result.project);
        store.setSavePath(result.path);
        setRecentProjects(rememberRecentProject(result.project, result.path));
        savedSnapshotRef.current = JSON.stringify(result.project);
        setSaveToast('ok');
        setTimeout(() => setSaveToast(null), 2000);
        setSaveAsProgress(prev => prev ? { ...prev, complete: true } : null);
        setTimeout(() => setSaveAsProgress(null), 1800);
        return result.path;
      }
      setSaveAsProgress(null);
      return null;
    } catch (e) {
      logger.error('[handleSaveAs] erreur:', e);
      setSaveAsProgress(null);
      setSaveToast('error');
      setTimeout(() => setSaveToast(null), 3000);
      return null;
    }
  }

  saveHandlerRef.current = handleSaveProject;
  saveAsHandlerRef.current = handleSaveProjectAs;

  async function applyLoadedProject(result) {
    store.loadProject(result.data);
    store.setMediaTags(result.mediaTags ?? {});
    store.setSavePath(result.path);
    setMediaLibraryPaths(result.mediaLibraryPaths ?? []);
    setRecentProjects(rememberRecentProject(result.data, result.path));
    savedSnapshotRef.current = JSON.stringify(result.data);
    autoSavePathRef.current = null;
    setAutoSavedPath(null);
    sdStore.clearDone();
    xttsStore.clearDone();
    // Recalculer les métadonnées ZIP manquantes pour les projets anciens
    const zipEntries = [];
    visitProjectEntries(result.data, (entry, ancestors) => {
      if (entry.type === 'zip' && entry.zipPath && (!entry.coverImage || !entry.coverAudio)) {
        zipEntries.push({ entry, ancestors });
      }
    });
    for (const { entry, ancestors } of zipEntries) {
      try {
        const nextFields = {};
        const json = await invoke('load_pack_zip', { zipPath: entry.zipPath });
        const data = JSON.parse(json);
        const squareOne = (data.stageNodes || []).find((node) => node.squareOne === true);
        if (!entry.coverImage && squareOne?.image) nextFields.coverImage = squareOne.image;
        if (!entry.coverAudio && squareOne?.audio) nextFields.coverAudio = squareOne.audio;
        if (!entry.name?.trim() && data.title?.trim()) nextFields.name = sanitizeImportedName(data.title.trim(), 'ZIP importe');
        if (Object.keys(nextFields).length > 0) store.updateItem(entry.id, nextFields);
      } catch (e) {
        const scope = ancestors.map((parent) => parent.name).join(' / ') || 'racine';
        logger.warn(`[handleLoad] ZIP métadonnées indisponibles (${scope}):`, entry.zipPath, e);
      }
    }
  }

  async function handleLoad() {
    const canContinue = await askSaveBeforeLeave(store.project, savedSnapshotRef.current, handleSaveProject);
    if (!canContinue) return;
    const result = await loadProject();
    if (result) {
      await applyLoadedProject(result);
    }
  }

  async function handleLoadRecent(path) {
    const canContinue = await askSaveBeforeLeave(store.project, savedSnapshotRef.current, handleSaveProject);
    if (!canContinue) return;
    try {
      const result = await loadProjectFromPath(path);
      await applyLoadedProject(result);
    } catch (e) {
      setRecentProjects(forgetRecentProject(path));
      alert(`Impossible d'ouvrir ce projet récent :\n${e}`);
    }
  }

  function hasWebmFiles(project) {
    const allAudio = collectProjectAudioPaths(project);
    return allAudio.some(f => f && f.toLowerCase().endsWith('.webm'));
  }

  function handleUpdateGlobalOption(key, value) {
    if (key === 'convertFormat' && !value && hasWebmFiles(store.project)) {
      setShowWebmWarning(true);
      return;
    }
    store.updateGlobalOption(key, value);
  }

  function handleAddEndNode() {
    store.setSelectedId('end-node');
  }

  function handleRemoveEndNode() {
    store.updateRootMedia('nightModeAudio', null);
    store.updateRootMedia('nightModeReturn', null);
    store.updateRootMedia('nightModeHomeReturn', null);
    store.updateGlobalOption('nightMode', false);
    store.setSelectedId('root');
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
  const errors = validationIssues.filter((issue) => issue.status === 'error').length;

  const statusText = projectType === null ? 'Choisissez un type de projet'
    : pathAuditPending ? 'Vérification des fichiers...'
    : '';
  const projectDirty = savedSnapshotRef.current === null
    ? isProjectDirty(store.project)
    : JSON.stringify(store.project) !== savedSnapshotRef.current;
  // Title bar shows the file stem when saved (manual or auto), pack title otherwise.
  const titleBarName = store.savePath
    ? store.savePath.replace(/\\/g, '/').replace(/.*\//, '').replace(/\.mbah$/i, '')
    : autoSavedPath
      ? autoSavedPath.replace(/\\/g, '/').replace(/.*\//, '').replace(/\.mbah$/i, '')
      : (store.project.name?.trim() || null);
  const canImportStories = (store.activeTab === 'edit' || store.activeTab === 'diagram') && store.project.projectType === 'pack';
  const canAddFolder = canImportStories;
  const canRecord = canImportStories;
  const shortcutLabels = useMemo(() => getShortcutLabelMap(keyboardShortcuts), [keyboardShortcuts]);

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
  const canGenerate = projectType !== null && !pathAuditPending && errors === 0;

  shortcutActionsRef.current = {
    newProject: handleNewProject,
    openProject: handleLoad,
    importStories: handleAddStory,
    addFolder: () => store.addMenu(),
    openStorySettings: () => setStorySettingsOpen(true),
    setActiveTab: store.setActiveTab,
    generate: handleGenerate,
    focusTreeSearch: () => setTreeSearchFocusTrigger((n) => n + 1),
    projectActionsVisible: projectType !== null,
    activeTab: store.activeTab,
    canImportStories,
    canAddFolder,
    canGenerate,
  };

  return (
    <ProjectContext.Provider value={{
      savePath: store.savePath,
      projectName: store.project.name || '',
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
        isDirty={projectDirty}
        hasSavePath={!!(store.savePath || autoSavedPath)}
        saveState={saveToast}
        showProjectMeta={projectType !== null}
        onOpenCredits={() => setCreditsOpen(true)}
      />

      {projectType !== null && (
        <Toolbar
          showProjectActions={projectType !== null}
          shortcutLabels={shortcutLabels}
          canImportStories={canImportStories}
          canAddFolder={canAddFolder}
          saveState={saveToast}
          generateDisabled={!canGenerate}
          onNewProject={handleNewProject}
          onOpenProject={handleLoad}
          onSaveProject={handleSave}
          onImportStories={() => handleAddStory()}
          onAddFolder={() => store.addMenu()}
          onRecord={handleToolbarRecord}
          canRecord={canRecord}
          onOpenStorySettings={() => setStorySettingsOpen(true)}
          onGenerate={handleGenerate}
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
              copyFilesEnabled={copyImportedFilesEnabled}
              onCopyFilesChange={handleCopyImportedFilesChange}
              workspaceDir={workspaceDir}
              onPickWorkspaceDir={handlePickWorkspaceDir}
              onConsolidateProject={handleConsolidateProject}
              autoSaveEnabled={autoSaveEnabled}
              onAutoSaveChange={setAutoSaveEnabled}
              autoSaveBackupLimit={autoSaveBackupLimit}
              onAutoSaveBackupLimitChange={setAutoSaveBackupLimit}
              themePreference={themePreference}
              onThemePreferenceChange={setThemePreference}
              keyboardShortcuts={keyboardShortcuts}
              onUpdateKeyboardShortcuts={setKeyboardShortcuts}
              xttsSettings={xttsSettings}
              onUpdateXttsSettings={handleUpdateXttsSettings}
              sdSettings={sdStore.sdSettings}
              onUpdateSdSettings={sdStore.updateSdSettings}
              onBackToHome={projectType === null ? () => store.setActiveTab('edit') : null}
              showCentralDiagram={showCentralDiagram}
              onShowCentralDiagramChange={setShowCentralDiagram}
              project={store.project}
              savePath={store.savePath}
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
              projectName={store.project.name || ''}
              onMediaCreated={handleMediaCreated}
            />
          )}
        </div>
      </div>

      {prefsModalOpen && renderDeferred(
        <OptionsTab
          copyFilesEnabled={copyImportedFilesEnabled}
          onCopyFilesChange={handleCopyImportedFilesChange}
          workspaceDir={workspaceDir}
          onPickWorkspaceDir={handlePickWorkspaceDir}
          onConsolidateProject={handleConsolidateProject}
          autoSaveEnabled={autoSaveEnabled}
          onAutoSaveChange={setAutoSaveEnabled}
          autoSaveBackupLimit={autoSaveBackupLimit}
          onAutoSaveBackupLimitChange={setAutoSaveBackupLimit}
          themePreference={themePreference}
          onThemePreferenceChange={setThemePreference}
          keyboardShortcuts={keyboardShortcuts}
          onUpdateKeyboardShortcuts={setKeyboardShortcuts}
          xttsSettings={xttsSettings}
          onUpdateXttsSettings={handleUpdateXttsSettings}
          sdSettings={sdStore.sdSettings}
          onUpdateSdSettings={sdStore.updateSdSettings}
          showCentralDiagram={showCentralDiagram}
          onShowCentralDiagramChange={setShowCentralDiagram}
          project={store.project}
          savePath={store.savePath}
          asModal
          onClose={() => setPrefsModalOpen(false)}
        />,
      )}

      {toolbarRecordOpen && renderDeferred(
        <RecordModal
          savePath={store.savePath}
          workspaceDir={workspaceDir}
          projectName={store.project.name}
          onSaved={handleToolbarRecordSaved}
          onClose={() => setToolbarRecordOpen(false)}
        />
      )}

      {storySettingsOpen && renderDeferred(
        <StorySettingsModal
          open={storySettingsOpen}
          projectType={store.project.projectType}
          globalOptions={store.project.globalOptions}
          onClose={() => setStorySettingsOpen(false)}
          onUpdateOption={handleUpdateGlobalOption}
        />,
      )}

      {/* Warning désactivation conversion avec fichiers webm */}
      {showWebmWarning && (
        <AppModalPortal>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ width: 360 }}>
            <div className="modal-header">
              <span>Fichiers .webm détectés</span>
              <button className="modal-close" onClick={() => setShowWebmWarning(false)}>×</button>
            </div>
            <div style={{ padding: '16px 20px', fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
              Un ou plusieurs fichiers audio sont au format <strong>.webm</strong>, qui n'est pas compatible avec la Boîte à Histoires.<br /><br />
              Désactiver <strong>«&nbsp;Convertir au bon format&nbsp;»</strong> risque de produire un pack non fonctionnel.
            </div>
            <div style={{ padding: '0 20px 16px', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => { store.updateGlobalOption('convertFormat', false); setShowWebmWarning(false); }}>
                Désactiver quand même
              </button>
              <button className="btn btn-primary" onClick={() => setShowWebmWarning(false)}>Garder activé</button>
            </div>
          </div>
        </AppModalPortal>
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
        <div className="bottom-validation-summary">
          {projectType !== null && !pathAuditPending ? (
            <span className="bottom-validation-item">
              <span className={`bottom-validation-dot ${errors > 0 ? 'is-error' : 'is-ok'}`} />
              <span>{errors > 0 ? `${errors} erreur${errors > 1 ? 's' : ''}` : 'Tout est en ordre'}</span>
            </span>
          ) : null}
        </div>
        <span className="status-text">{statusText}</span>
        {projectType !== null && (
          <button
            className={`rq-bottombar-btn${bottomPanelOpen && bottomPanelTab === 'media' ? ' is-active' : ''}`}
            onClick={() => {
              setBottomPanelTab('media');
              setBottomPanelOpen((open) => bottomPanelTab === 'media' ? !open : true);
            }}
          >
            Médias
            <span>({mediaLibraryCount})</span>
          </button>
        )}
        {projectType !== null && (
          <button
            className={`rq-bottombar-btn${bottomPanelOpen && bottomPanelTab === 'queue' ? ' is-active' : (renderQueue.activeCount > 0 ? ' has-active' : '')}`}
            onClick={() => {
              setBottomPanelTab('queue');
              setBottomPanelOpen((open) => bottomPanelTab === 'queue' ? !open : true);
            }}
          >
            {renderQueue.activeCount > 0 && <span className="rq-spinner" style={{ borderColor: 'currentColor', borderTopColor: 'transparent' }} />}
            File de rendu
            {!bottomPanelOpen && renderQueue.activeCount > 0 && <span className="bottom-status-pill">{renderQueue.activeCount}</span>}
            {!bottomPanelOpen && renderQueue.activeCount === 0 && renderQueue.hasResults && <span className="bottom-status-pill is-done">✓</span>}
            {bottomPanelOpen && renderQueue.activeCount > 0 && <span>({renderQueue.activeCount})</span>}
          </button>
        )}
        {projectType !== null && (
          <button
            className={`rq-bottombar-btn${bottomPanelOpen && bottomPanelTab === 'ai' ? ' is-active' : (aiQueueActiveCount > 0 ? ' has-active' : '')}`}
            onClick={() => {
              setBottomPanelTab('ai');
              setBottomPanelOpen((open) => bottomPanelTab === 'ai' ? !open : true);
            }}
          >
            {aiQueueActiveCount > 0 && <span className="rq-spinner" style={{ borderColor: 'currentColor', borderTopColor: 'transparent' }} />}
            File IA
            {!bottomPanelOpen && aiQueueActiveCount > 0 && <span className="bottom-status-pill">{aiQueueActiveCount}</span>}
            {!bottomPanelOpen && aiQueueActiveCount === 0 && aiQueueHasResults && <span className="bottom-status-pill is-done">✓</span>}
            {bottomPanelOpen && aiQueueActiveCount > 0 && <span>({aiQueueActiveCount})</span>}
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
  );
}
