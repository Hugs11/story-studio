import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  autoSaveEphemeralProject,
  ensureWorkspaceDir,
  getWorkspaceDir,
  loadProjectFromPath,
} from '../store/projectIO';
import { isProjectWorthAutosaving } from '../store/autosaveDecision';
import { logger } from '../utils/logger';

const SESSION_RECOVERY_FILE = '.session-recovery.mbah';

function joinLocalPath(dir, fileName) {
  if (!dir) return '';
  const trimmed = String(dir).replace(/[\\/]+$/, '');
  const sep = String(dir).includes('\\') ? '\\' : '/';
  return `${trimmed}${sep}${fileName}`;
}

// Machine à sessions de travail (persistance différée) : possède les états
// `sessionMode`/`sessionWorkspaceDir`, les refs éphémères, le snapshot anti-crash,
// les reprises après crash et toutes les transitions du cycle de vie (préparer,
// promouvoir, abandonner, nettoyer). Invariant central : seul ce hook décide qui
// nettoie le dossier de session éphémère, quand, et dans quel ordre.
export function useWorkSession({
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
}) {
  const [sessionMode, setSessionMode] = useState(null); // null | 'ephemeral' | 'project'
  const [sessionWorkspaceDir, setSessionWorkspaceDir] = useState('');
  const [sessionRecoveries, setSessionRecoveries] = useState([]);
  const sessionModeRef = useRef(null);
  // Miroir ref de sessionWorkspaceDir : les nettoyages appelés depuis des fermetures
  // montées une seule fois (garde de fermeture de fenêtre) doivent lire la valeur
  // courante, pas celle du rendu où la fermeture a été créée.
  const sessionWorkspaceDirRef = useRef('');
  const ephemeralSnapshotPathRef = useRef(null);
  const ephemeralSavedSnapshotRef = useRef(null);
  // One-shot : a-t-on déjà écrit le snapshot anti-crash pour cette session ?
  const ephemeralSnapshotSeededRef = useRef(false);

  // Reprises après crash : snapshots orphelins proposés comme projets sur l'accueil.
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

  useEffect(() => {
    sessionModeRef.current = sessionMode;
    sessionWorkspaceDirRef.current = sessionWorkspaceDir;
    ephemeralSnapshotPathRef.current = sessionMode === 'ephemeral' && sessionWorkspaceDir
      ? joinLocalPath(sessionWorkspaceDir, SESSION_RECOVERY_FILE)
      : null;
    if (sessionMode !== 'ephemeral') {
      ephemeralSavedSnapshotRef.current = null;
    }
  }, [sessionMode, sessionWorkspaceDir]);

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

  // Prépare une session de travail (éphémère par défaut, ou workspace réel si
  // l'option correspondante est active), fixe le type de projet et renvoie le dossier cible
  // d'écriture. Partagé par « Retour à l’accueil » et les funnels d'entrée éditeur.
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

  // Nettoie le dossier de la session éphémère courante (no-op sinon). Awaitable ;
  // les appelants fire-and-forget peuvent l'appeler sans await, l'échec est loggé ici.
  async function cleanupEphemeralSession() {
    if (sessionModeRef.current !== 'ephemeral' || !sessionWorkspaceDirRef.current) return;
    await invoke('cleanup_session_workspace', { path: sessionWorkspaceDirRef.current }).catch((error) => {
      logger.warn('session:cleanup-error', error);
    });
  }

  // Retour à l'accueil : ferme la session sans toucher au
  // store ni au dossier (le nettoyage éventuel est un appel séparé).
  function resetWorkSession() {
    ephemeralSavedSnapshotRef.current = null;
    setSessionMode(null);
    setSessionWorkspaceDir('');
    setWorkspaceDirState(configuredWorkspaceDir);
  }

  // Échec d'un atterrissage de funnel : nettoie la session tout juste créée
  // (jamais le workspace réel), vide le projet et revient à l'accueil.
  function abandonWorkSession(sessionDir) {
    if (!useWorkspaceForNewProjects && sessionDir) {
      invoke('cleanup_session_workspace', { path: sessionDir }).catch(() => {});
    }
    store.resetProject();
    setSessionMode(null);
    setSessionWorkspaceDir('');
    setWorkspaceDirState(configuredWorkspaceDir);
    workspaceDirRef.current = configuredWorkspaceDir;
  }

  // Transaction d'atterrissage de funnel : prépare la session, exécute l'import
  // (`importFn(workspaceDir)`), et en cas d'échec logge puis abandonne la session
  // avant de relancer l'erreur — le funnel affiche alors son écran d'erreur et
  // l'accueil est revenu dans un état propre.
  async function runFunnelLanding(type, importFn, { errorLog = 'funnel:land-error' } = {}) {
    const workspaceDir = await prepareNewWorkSession(type);
    try {
      return await importFn(workspaceDir);
    } catch (error) {
      logger.error(errorLog, error);
      abandonWorkSession(workspaceDir);
      throw error;
    }
  }

  // Promotion « Enregistrer comme projet » : seule transition qui supprime la
  // session éphémère en cours (sauf cleanupSession=false quand des transferts de
  // médias ont échoué : la session reste récupérable). Bascule en mode projet.
  function promoteSessionToProject({ workspaceDir = null, cleanupSession = true } = {}) {
    if (cleanupSession !== false && sessionModeRef.current === 'ephemeral' && sessionWorkspaceDirRef.current) {
      invoke('cleanup_session_workspace', { path: sessionWorkspaceDirRef.current }).catch((error) => {
        logger.warn('session:cleanup-error', error);
      });
    }
    sessionModeRef.current = 'project';
    sessionWorkspaceDirRef.current = '';
    setSessionMode('project');
    setSessionWorkspaceDir('');
    if (workspaceDir) {
      setConfiguredWorkspaceDir(workspaceDir);
      setWorkspaceDirState(workspaceDir);
    }
  }

  // Passage en mode projet après chargement d'un `.mbah` existant (pas de
  // promotion : la session précédente a été nettoyée avant remplacement).
  async function enterProjectMode() {
    const realWorkspace = configuredWorkspaceDir || await getWorkspaceDir();
    setSessionMode('project');
    setSessionWorkspaceDir('');
    setWorkspaceDirState(realWorkspace);
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
      sessionWorkspaceDirRef.current = recovery.sessionDir;
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

  return {
    sessionMode,
    sessionWorkspaceDir,
    sessionRecoveries,
    sessionModeRef,
    ephemeralSnapshotPathRef,
    ephemeralSavedSnapshotRef,
    prepareNewWorkSession,
    cleanupEphemeralSession,
    resetWorkSession,
    abandonWorkSession,
    runFunnelLanding,
    promoteSessionToProject,
    enterProjectMode,
    handleRecoverSession,
    handleIgnoreSessionRecovery,
  };
}
