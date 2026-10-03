import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  autoSaveEphemeralProject,
  collectLiveSessionDependencies,
  ensureWorkspaceDir,
  getWorkspaceDir,
  loadProjectFromPath,
  previewProjectFromPath,
} from '../store/projectIO';
import { isProjectWorthAutosaving } from '../store/autosaveDecision';
import { createWorkSnapshot } from '../store/projectHelpers';
import { collectSessionBoundReferences } from '../store/sessionMediaTriage';
import {
  acceptEphemeralSnapshotSeed,
  beginEphemeralSnapshotSeed,
  createEphemeralSnapshotSeedState,
  enqueueEphemeralSnapshotWrite,
  finishEphemeralSnapshotSeed,
  resetEphemeralSnapshotSeedState,
} from '../store/ephemeralSnapshotSeed';
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
  mediaTags,
  currentWorkSnapshot,
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
  const ephemeralSnapshotSeedStateRef = useRef(createEphemeralSnapshotSeedState());
  // Jeton d'identité de la session de travail courante. Il change à **chaque**
  // transition, si bien qu'une opération longue partie d'une session peut
  // constater à son retour qu'elle n'y est plus : c'est la condition pour
  // qu'un enregistrement lancé dans la session A ne promeuve, ne trie ni ne
  // supprime jamais le dossier de la session B devenue courante entre-temps.
  const sessionTicketRef = useRef({});

  // Toute transition de session passe par ici : le jeton et l'état du filet
  // anti-crash sont périmés ensemble, jamais l'un sans l'autre.
  function beginSessionTransition(seed = undefined) {
    sessionTicketRef.current = {};
    if (seed) resetEphemeralSnapshotSeedState(ephemeralSnapshotSeedStateRef.current, seed);
    else resetEphemeralSnapshotSeedState(ephemeralSnapshotSeedStateRef.current);
  }

  // Ce que vaut la session à l'instant où une opération longue démarre. Les
  // appelants gardent ce ticket et le représentent à l'arrivée.
  function captureWorkSession() {
    return {
      ticket: sessionTicketRef.current,
      mode: sessionModeRef.current,
      dir: sessionWorkspaceDirRef.current,
    };
  }

  // Vrai seulement si la session courante est **exactement** celle capturée :
  // même jeton, même mode, même dossier.
  function isWorkSessionCurrent(session) {
    return !!session
      && session.ticket === sessionTicketRef.current
      && session.mode === sessionModeRef.current
      && session.dir === sessionWorkspaceDirRef.current;
  }

  // Reprises après crash : snapshots orphelins proposés comme projets sur l'accueil.
  // Les énumérer n'est qu'une lecture : l'aperçu s'arrête à l'enveloppe, donc
  // aucun snapshot n'est migré, normalisé, validé par Rust ni réécrit tant que
  // l'utilisateur n'a pas choisi de reprendre — c'est `handleRecoverSession` qui
  // ouvre réellement le fichier, par le même chemin qu'une ouverture explicite.
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
            const preview = await previewProjectFromPath(recovery.snapshotPath);
            return {
              ...recovery,
              projectName: preview.projectName || 'Projet récupérable',
              projectType: preview.projectType || 'pack',
              thumbnailImage: preview.thumbnailImage,
            };
          } catch {
            return {
              ...recovery,
              projectName: 'Projet récupérable',
              // Snapshot illisible : son éditeur est inconnu, l'accueil n'en affiche aucun.
              projectType: null,
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
  }, [sessionMode, sessionWorkspaceDir]);

  // Filet anti-crash : sérialise immédiatement chaque nouvelle signature de
  // travail (projet + catalogue + tags), sans attendre la tick d'autosave.
  useEffect(() => {
    if (sessionMode !== 'ephemeral') return;
    const snapshotPath = joinLocalPath(sessionWorkspaceDir, SESSION_RECOVERY_FILE);
    if (!snapshotPath) return;
    // Même critère que saveProject(autosave) : n'écrire que si le projet a un
    // contenu réel (sinon saveProject jette « projet vide »).
    if (!isProjectWorthAutosaving(store.project, mediaLibraryPaths, mediaLibraryCountRef.current)
      && Object.keys(mediaTags ?? {}).length === 0) return;
    const sessionToken = ephemeralSnapshotSeedStateRef.current.sessionToken;
    const capturedProject = store.project;
    const capturedPaths = mediaLibraryPaths;
    const capturedTags = mediaTags;
    enqueueEphemeralSnapshotWrite(ephemeralSnapshotSeedStateRef.current, async () => {
      const state = ephemeralSnapshotSeedStateRef.current;
      if (state.sessionToken !== sessionToken
        || sessionModeRef.current !== 'ephemeral'
        || ephemeralSnapshotPathRef.current !== snapshotPath) return;
      const write = beginEphemeralSnapshotSeed(state, {
        sessionMode: 'ephemeral',
        path: snapshotPath,
        snapshot: currentWorkSnapshot,
      });
      if (!write) return;
      try {
        await autoSaveEphemeralProject(capturedProject, sessionWorkspaceDir, write.path, {
          mediaTags: capturedTags,
          mediaLibraryPaths: capturedPaths,
          totalMediaCount: mediaLibraryCountRef.current,
        });
        acceptEphemeralSnapshotSeed(state, write, {
          sessionMode: sessionModeRef.current,
          path: ephemeralSnapshotPathRef.current,
        });
      } catch (error) {
        logger.error('session:seed-snapshot-error', error);
      } finally {
        finishEphemeralSnapshotSeed(state, write);
      }
    });
  }, [currentWorkSnapshot, mediaLibraryPaths, mediaTags, sessionMode, sessionWorkspaceDir, store.project]);

  // Prépare une session de travail (éphémère par défaut, ou workspace réel si
  // l'option correspondante est active), fixe le type de projet et renvoie le dossier cible
  // d'écriture. Partagé par « Retour à l’accueil » et les funnels d'entrée éditeur.
  //
  // `applyProjectType: false` laisse le projet courant intact : l'Éditeur avancé
  // n'a pas de type hiérarchique à poser, et en poser un ferait clignoter
  // l'espace de travail Libre le temps que le pack soit acquis. Le projet est
  // alors installé en une fois par `loadProject`, qui fait avancer l'époque.
  async function prepareNewWorkSession(type, { applyProjectType = true } = {}) {
    beginSessionTransition();
    let workspaceDir;
    if (useWorkspaceForNewProjects) {
      const realWorkspace = configuredWorkspaceDir || await ensureWorkspaceDir();
      if (!configuredWorkspaceDir) setConfiguredWorkspaceDir(realWorkspace);
      sessionModeRef.current = 'project';
      sessionWorkspaceDirRef.current = '';
      setSessionMode('project');
      setSessionWorkspaceDir('');
      setWorkspaceDirState(realWorkspace);
      workspaceDirRef.current = realWorkspace;
      workspaceDir = realWorkspace;
    } else {
      const sessionDir = await invoke('create_session_workspace');
      // Les miroirs ref d'abord : une opération partie de la session
      // précédente doit voir la nouvelle session dès cette ligne, sans
      // attendre le rendu qui synchronise les états.
      sessionModeRef.current = 'ephemeral';
      sessionWorkspaceDirRef.current = sessionDir;
      setSessionMode('ephemeral');
      setSessionWorkspaceDir(sessionDir);
      setWorkspaceDirState(sessionDir);
      workspaceDirRef.current = sessionDir;
      workspaceDir = sessionDir;
    }
    autoSavePathRef.current = null;
    autoSaveSnapshotRef.current = null;
    setAutoSavedPath(null);
    importedPackPendingMetaRef.current = false;
    store.setSavePath(null);
    if (applyProjectType) store.setProjectType(type);
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
    beginSessionTransition();
    sessionModeRef.current = null;
    sessionWorkspaceDirRef.current = '';
    setSessionMode(null);
    setSessionWorkspaceDir('');
    setWorkspaceDirState(configuredWorkspaceDir);
  }

  // Échec d'un atterrissage de funnel : nettoie la session tout juste créée
  // (jamais le workspace réel), vide le projet et revient à l'accueil.
  function abandonWorkSession(sessionDir) {
    beginSessionTransition();
    if (!useWorkspaceForNewProjects && sessionDir) {
      invoke('cleanup_session_workspace', { path: sessionDir }).catch(() => {});
    }
    store.resetProject();
    sessionModeRef.current = null;
    sessionWorkspaceDirRef.current = '';
    setSessionMode(null);
    setSessionWorkspaceDir('');
    setWorkspaceDirState(configuredWorkspaceDir);
    workspaceDirRef.current = configuredWorkspaceDir;
  }

  // Transaction d'atterrissage de funnel : prépare la session, exécute l'import
  // (`importFn(workspaceDir)`), et en cas d'échec logge puis abandonne la session
  // avant de relancer l'erreur — le funnel affiche alors son écran d'erreur et
  // l'accueil est revenu dans un état propre.
  async function runFunnelLanding(type, importFn, {
    errorLog = 'funnel:land-error',
    applyProjectType = true,
  } = {}) {
    const workspaceDir = await prepareNewWorkSession(type, { applyProjectType });
    try {
      return await importFn(workspaceDir);
    } catch (error) {
      logger.error(errorLog, error);
      abandonWorkSession(workspaceDir);
      throw error;
    }
  }

  // Promotion « Enregistrer comme projet » : seule transition qui supprime la
  // session éphémère en cours. La session et le travail enregistré doivent être
  // encore courants, les transferts réussis et les dépendances sorties du dossier.
  // Tant que ces conditions ne sont pas réunies, conserver aussi le mode
  // éphémère et son filet de récupération.
  async function promoteSessionToProject({
    session = null,
    isPublicationCurrent = null,
    project = null,
    workspaceDir = null,
    cleanupSession = true,
  } = {}) {
    // Une promotion appartient à la session d'où elle est partie. Si une autre
    // session est devenue courante entre-temps, ce résultat ne la concerne pas :
    // ni son mode, ni son dossier, ni ses médias ne lui appartiennent. Sans ce
    // refus, un Save As lent lisait le dossier de la session courante tout en
    // cherchant ses dépendances dans le projet d'une autre, et supprimait des
    // fichiers encore référencés.
    const canPromote = () => isWorkSessionCurrent(session)
      && isPublicationCurrent?.() === true;
    if (!canPromote()) {
      logger.warn(`session:promotion-refused dir='${session?.dir}' current='${sessionWorkspaceDirRef.current}'`);
      return;
    }
    const sessionDir = sessionWorkspaceDirRef.current;
    const wasEphemeral = sessionModeRef.current === 'ephemeral' && !!sessionDir;
    if (wasEphemeral) {
      if (cleanupSession === false) return;
      // Une écriture déjà engagée doit finir avant la suppression de son dossier.
      // Une mutation pendant cette attente périme également la promotion.
      await ephemeralSnapshotSeedStateRef.current.writeChain.catch(() => {});
      const pending = await collectLiveSessionDependencies(project, sessionDir);
      if (pending.length > 0 || !canPromote()) {
        logger.warn(`session:cleanup-skipped dependencies=${pending.length} dir='${sessionDir}'`);
        return;
      }
    }
    beginSessionTransition();
    // Aucun await entre le dernier contrôle et la bascule : passé cette ligne,
    // les snapshots encore en file sont invalidés par le jeton de transition.
    // Une étape d'historique qui désigne encore un fichier de session (un média
    // retiré avant la sauvegarde, donc ni copié ni trié) ne sera plus lisible
    // après le nettoyage : elle n'est plus restaurable.
    if (wasEphemeral) {
      store.relocateHistory((step) => (
        collectSessionBoundReferences({ project: step, sessionDir }).length > 0 ? null : step
      ));
    }
    sessionModeRef.current = 'project';
    sessionWorkspaceDirRef.current = '';
    setSessionMode('project');
    setSessionWorkspaceDir('');
    if (workspaceDir) {
      setConfiguredWorkspaceDir(workspaceDir);
      setWorkspaceDirState(workspaceDir);
      workspaceDirRef.current = workspaceDir;
    } else {
      // Le dossier du projet n'est pas un nouveau workspace configuré. Quand
      // l'option workspace est désactivée, sortir de la session restaure donc
      // la préférence existante sans la remplacer par le dossier du `.mbah`.
      setWorkspaceDirState(configuredWorkspaceDir);
      workspaceDirRef.current = configuredWorkspaceDir;
    }
    if (!wasEphemeral) return;
    // Le contrôle des dépendances a rendu la main : un instantané parti pendant
    // cette attente a vu la session encore éphémère et écrit dans son dossier.
    // La bascule ci-dessus annule ceux qui n'ont pas démarré ; celui qui est en
    // vol doit finir avant la suppression, sinon il crée son fichier temporaire
    // dans un dossier qui n'existe plus.
    await ephemeralSnapshotSeedStateRef.current.writeChain.catch(() => {});
    await invoke('cleanup_session_workspace', { path: sessionDir }).catch((error) => {
      logger.warn('session:cleanup-error', error);
    });
  }

  // Passage en mode projet après chargement d'un `.mbah` existant (pas de
  // promotion : la session précédente a été nettoyée avant remplacement).
  async function enterProjectMode() {
    beginSessionTransition();
    sessionModeRef.current = 'project';
    sessionWorkspaceDirRef.current = '';
    const realWorkspace = configuredWorkspaceDir || await getWorkspaceDir();
    setSessionMode('project');
    setSessionWorkspaceDir('');
    setWorkspaceDirState(realWorkspace);
  }

  async function handleRecoverSession(recovery) {
    if (!recovery?.snapshotPath || !recovery?.sessionDir) return;
    beginSessionTransition();
    try {
      const result = await loadProjectFromPath(recovery.snapshotPath, {
        preserveEmptyProjectName: true,
      });
      store.loadProject(result.data);
      store.setMediaTags(result.mediaTags ?? {});
      store.setSavePath(null);
      setMediaLibraryPaths(result.mediaLibraryPaths ?? []);
      savedSnapshotRef.current = null;
      autoSavePathRef.current = null;
      autoSaveSnapshotRef.current = null;
      setAutoSavedPath(null);
      sessionModeRef.current = 'ephemeral';
      sessionWorkspaceDirRef.current = recovery.sessionDir;
      setSessionMode('ephemeral');
      setSessionWorkspaceDir(recovery.sessionDir);
      setWorkspaceDirState(recovery.sessionDir);
      workspaceDirRef.current = recovery.sessionDir;
      // Snapshot déjà sur disque : la signature unifiée évite une réécriture immédiate.
      beginSessionTransition({
        seeded: true,
        savedSnapshot: createWorkSnapshot(
          result.data,
          result.mediaLibraryPaths ?? [],
          result.mediaTags ?? {},
        ),
      });
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
    // Ignorer supprime définitivement l'instantané et les médias de session :
    // l'auteur le confirme d'abord.
    const choice = await showChoiceDialog({
      title: 'Ignorer cette reprise',
      message: 'Supprimer définitivement ce travail non enregistré ?',
      variant: 'warning',
      cancelValue: 'cancel',
      actions: [
        { value: 'cancel', label: 'Annuler', autoFocus: true },
        { value: 'delete', label: 'Supprimer', kind: 'danger-outline' },
      ],
    });
    if (choice !== 'delete') return;
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
    ephemeralSnapshotSeedStateRef,
    captureWorkSession,
    isWorkSessionCurrent,
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
