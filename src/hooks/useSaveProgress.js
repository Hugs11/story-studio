import { useCallback, useRef, useState } from 'react';
import {
  discardMediaCopies,
  ensureWorkspaceDir,
  rememberRecentProject,
  saveProject,
  saveProjectAs,
} from '../store/projectIO';
import {
  assertProjectCanSaveInPlace,
  applySavePublication,
  classifySavePublication,
  createWorkSnapshot,
  isSaveInputStillCurrent,
  publishedWorkSnapshot,
  SAVE_PUBLICATION,
  shouldAbortEphemeralPromotion,
} from '../store/projectHelpers';
import { normalizeWorkProject } from '../store/projectWorkState';
import { logger } from '../utils/logger';
import { applySessionMediaTriage } from '../store/sessionMediaTriage';
import { mapProjectMediaPaths } from '../store/projectMediaPaths';
import { walkProjectMediaReferences } from '../store/projectModel/index.js';
import { pathKey } from '../utils/fileUtils';

function relocateHistoryMedia(store, replacementEntries) {
  const replacements = new Map(replacementEntries.filter(([from, to]) => from && to));
  if (replacements.size === 0) return;
  store.relocateHistory((project) => {
    const moved = [...walkProjectMediaReferences(project)]
      .some((ref) => replacements.has(pathKey(ref.path)));
    return moved
      ? mapProjectMediaPaths(project, (path) => replacements.get(pathKey(path)) ?? path)
      : project;
  });
}

export function useSaveProgress({
  store,
  configuredWorkspaceDir = '',
  mediaLibraryPathsRef,
  setMediaLibraryPaths,
  autoSaveEnabled,
  autoSaveBackupLimit,
  savedSnapshotRef,
  autoSaveSnapshotRef,
  captureWorkSession = null,
  isWorkSessionCurrent = null,
  isSavingRef,
  setSaveToast,
  showErrorDialog = null,
  setRecentProjects,
  maybeOfferTransferIntoProject,
  triageSessionMedia = null,
  onProjectSaved = null,
}) {
  const [saveProgress, setSaveProgress] = useState(null); // null | { lines: string[], complete: boolean }
  const [saveAsProgress, setSaveAsProgress] = useState(null);
  const liveStoreRef = useRef(store);
  liveStoreRef.current = store;

  // Publication commune aux trois écritures du hook : enregistrement explicite,
  // copie sous et instantané d'après transfert/import. Elles avaient chacune
  // leur version de la règle, et c'est par leurs écarts que le travail se
  // perdait — un instantané réinstallait un projet antérieur par-dessus une
  // mutation, une copie sous réinstallait un catalogue périmé par-dessus un
  // média tout juste ajouté. Il n'y a donc plus qu'une règle, et elle vit ici.
  //
  // Ce qui est comparé n'est pas l'identité des objets mais la **signature du
  // travail tel qu'il sera après publication** : le projet réinstallé si son
  // entrée est encore celle du store, le catalogue et les tags réellement en
  // mémoire. Un fichier valide devient toujours le chemin courant ; il n'est
  // déclaré enregistré que s'il porte exactement ce travail-là.
  const publishSaveResult = useCallback(({
    result: written,
    projectAtStart,
    mediaLibraryPathsAtStart,
    savedMediaLibraryPaths,
    savedMediaTags,
    workEpochAtStart,
    logLabel,
  }) => {
    // Le store n'installe jamais le projet écrit tel quel : il le normalise
    // (séparateurs de chemins d'une image rangée, par exemple). La signature
    // publiée, le projet courant publié et la synchronisation portent donc tous
    // sur ce même projet normalisé, sans quoi le travail à peine enregistré
    // paraîtrait modifié.
    const result = { ...written, project: normalizeWorkProject(written.project) };
    const currentStore = liveStoreRef.current;
    const replaced = currentStore.workEpochRef.current !== workEpochAtStart;
    const projectStillCurrent = isSaveInputStillCurrent(projectAtStart, currentStore.project);
    // Le catalogue réconcilié est réinstallé avant de juger la fraîcheur, sinon
    // une simple réconciliation ferait passer le résultat pour périmé — mais
    // seulement s'il n'a pas bougé depuis le départ : réinstaller par-dessus une
    // modification concurrente effacerait le média qu'elle vient d'ajouter.
    if (
      !replaced
      && result.mediaLibraryPaths
      && isSaveInputStillCurrent(mediaLibraryPathsAtStart, mediaLibraryPathsRef.current)
    ) {
      setMediaLibraryPaths(result.mediaLibraryPaths);
      mediaLibraryPathsRef.current = result.mediaLibraryPaths;
    }
    const savedSnapshot = createWorkSnapshot(
      result.project,
      savedMediaLibraryPaths,
      savedMediaTags,
    );
    const decision = classifySavePublication({
      replaced,
      savedSnapshot,
      currentSnapshot: replaced ? null : publishedWorkSnapshot({
        projectStillCurrent,
        resultProject: result.project,
        currentProject: currentStore.project,
        mediaLibraryPaths: mediaLibraryPathsRef.current,
        mediaTags: currentStore.mediaTags,
      }),
    });
    applySavePublication({
      decision,
      work: currentStore,
      result,
      savedSnapshot,
      projectStillCurrent,
      savedSnapshotRef,
      autoSaveSnapshotRef,
    });
    if (decision !== SAVE_PUBLICATION.CURRENT) {
      logger.warn(`${logLabel}:not-published decision=${decision} path='${result.path}'`);
    }
    return decision;
  }, [autoSaveSnapshotRef, mediaLibraryPathsRef, savedSnapshotRef, setMediaLibraryPaths]);

  const persistProjectSnapshot = useCallback(async (project, savePath) => {
    const liveStore = liveStoreRef.current;
    const workEpochAtStart = liveStore.workEpochRef.current;
    const mediaTagsAtStart = liveStore.mediaTags;
    const mediaLibraryPathsAtStart = mediaLibraryPathsRef.current;
    const result = await saveProject(project, savePath, null, {
      mediaTags: mediaTagsAtStart,
      mediaLibraryPaths: mediaLibraryPathsAtStart,
      workspaceDir: configuredWorkspaceDir || null,
    });
    if (!result?.path) return null;
    // Un instantané suit un transfert ou un import : il écrit un état dérivé,
    // pas forcément le dernier. Il passe donc par la même publication que les
    // sauvegardes explicites, et ne réinstalle rien de ce qu'une mutation
    // survenue pendant l'écriture aurait rendu périmé.
    const decision = publishSaveResult({
      result,
      projectAtStart: project,
      mediaLibraryPathsAtStart,
      savedMediaLibraryPaths: result.mediaLibraryPaths ?? mediaLibraryPathsAtStart,
      savedMediaTags: mediaTagsAtStart,
      workEpochAtStart,
      logLabel: 'snapshot',
    });
    if (decision === SAVE_PUBLICATION.REPLACED) return result.path;
    setSaveToast('ok');
    setTimeout(() => setSaveToast(null), 2000);
    return result.path;
  }, [
    configuredWorkspaceDir,
    mediaLibraryPathsRef,
    publishSaveResult,
    setSaveToast,
  ]);

  const handleSaveProject = useCallback(async ({
    silent = false,
    projectOverride = null,
    mediaTagsOverride = null,
    mediaLibraryPathsOverride = null,
    returnResult = false,
  } = {}) => {
    // Serializes saves inside the app; external edits to the same .mbah remain
    // outside this guard and are handled by the next explicit load/save cycle.
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
    const liveStore = liveStoreRef.current;
    const workEpochAtStart = liveStore.workEpochRef.current;
    const projectToSave = projectOverride ?? liveStore.project;
    const mediaTagsToSave = mediaTagsOverride ?? liveStore.mediaTags;
    const mediaLibraryPathsToSave = mediaLibraryPathsOverride ?? mediaLibraryPathsRef.current;
    logger.info(`save:start kind=${silent ? 'auto' : 'manual'} hasPath=${!!liveStore.savePath} projectType=${projectToSave?.projectType || 'none'} entries=${projectToSave?.rootEntries?.length ?? 0}`);
    try {
      // Un savePath survit hors historique. Si un état invalide atteignait le
      // store, il ne doit jamais pouvoir écraser le dernier fichier valide.
      assertProjectCanSaveInPlace(projectToSave, liveStore.savePath);
      let result = await saveProject(projectToSave, liveStore.savePath, onProgress, {
        autosave: silent,
        backupLimit: autoSaveEnabled ? autoSaveBackupLimit : 0,
        mediaTags: mediaTagsToSave,
        mediaLibraryPaths: mediaLibraryPathsToSave,
        workspaceDir: configuredWorkspaceDir || null,
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
          try {
            result = await saveProject(transferResult.project, result.path, onProgress, {
              mediaTags: mediaTagsToSave,
              mediaLibraryPaths: mediaLibraryPathsToSave,
              workspaceDir: configuredWorkspaceDir || null,
            });
          } catch (error) {
            // Le fichier précédent ne désigne pas ces copies : sans la
            // réécriture, elles ne seraient que des fichiers en trop.
            await discardMediaCopies(transferResult.copies ?? []);
            throw error;
          }
        }
        publishSaveResult({
          result,
          projectAtStart: projectToSave,
          mediaLibraryPathsAtStart: mediaLibraryPathsToSave,
          savedMediaLibraryPaths: result.mediaLibraryPaths ?? mediaLibraryPathsToSave,
          savedMediaTags: mediaTagsToSave,
          workEpochAtStart,
          logLabel: 'save',
        });
        setRecentProjects(rememberRecentProject(result.project, result.path));
        await onProjectSaved?.(result);
        if (!silent) {
          setSaveProgress(prev => prev ? { ...prev, complete: true } : null);
          setTimeout(() => setSaveProgress(null), 1500);
        }
        setSaveToast('ok');
        setTimeout(() => setSaveToast(null), 2000);
        logger.info(`save:done path='${result.path}' kind=${silent ? 'auto' : 'manual'}`);
        return returnResult ? result : result.path;
      }
      setSaveProgress(null);
      return null;
    } catch (e) {
      logger.error('save:error', e);
      showErrorDialog?.({
        title: 'Enregistrement impossible',
        message: `Le projet n'a pas pu être enregistré : ${e?.message ?? e}`,
      });
      setSaveProgress(null);
      setSaveToast('error');
      setTimeout(() => setSaveToast(null), 3000);
      return null;
    } finally {
      isSavingRef.current = false;
    }
  }, [
    autoSaveBackupLimit,
    autoSaveEnabled,
    configuredWorkspaceDir,
    isSavingRef,
    maybeOfferTransferIntoProject,
    mediaLibraryPathsRef,
    publishSaveResult,
    setRecentProjects,
    setSaveToast,
    showErrorDialog,
    onProjectSaved,
  ]);

  const handleSaveProjectAs = useCallback(async () => {
    let progressStarted = false;
    function onProgress(step) {
      if (!progressStarted) {
        progressStarted = true;
        setSaveAsProgress({ lines: [step], complete: false });
      } else {
        setSaveAsProgress(prev => prev ? { ...prev, lines: [...prev.lines, step] } : { lines: [step], complete: false });
      }
    }
    // Copies du transfert : elles ne valent que par le fichier qui les
    // désigne. Tant qu'il n'est pas écrit, un abandon ou un échec les retire.
    let transferCopies = [];
    let transferCopiesSaved = false;
    try {
      const liveStore = liveStoreRef.current;
      const workEpochAtStart = liveStore.workEpochRef.current;
      const projectAtStart = liveStore.project;
      const mediaTagsAtStart = liveStore.mediaTags;
      const mediaLibraryPathsAtStart = mediaLibraryPathsRef.current;
      // Session épinglée au départ. Tout ce qui touche au dossier de session —
      // tri des médias, promotion, nettoyage — vise **celle-là** ; si une autre
      // session est devenue courante pendant l'écriture, ce résultat ne la
      // concerne pas et n'a pas le droit d'y toucher.
      const sessionAtStart = captureWorkSession?.() ?? null;
      const sessionStillCurrent = () => (
        !!sessionAtStart && (isWorkSessionCurrent?.(sessionAtStart) ?? true)
      );
      const isEphemeralSession = sessionAtStart?.mode === 'ephemeral';
      // Les médias d'un projet enregistré vont dans l'emplacement de travail,
      // que l'option « Utiliser un workspace pour les nouveaux projets » soit
      // active ou non, et jamais dans des sous-dossiers à côté du `.mbah`.
      const configuredOutputDir = configuredWorkspaceDir || await ensureWorkspaceDir();
      // Une session éphémère ne pose son fichier qu'une fois ses médias
      // copiés : écrit d'abord, il désignait le dossier de session, voué au
      // nettoyage, et survivait à l'abandon d'un transfert incomplet. Écrire
      // en dernier ne demande de supprimer aucun fichier — ce qui vaut sur les
      // trois plateformes, et protège le fichier qu'un auteur choisit
      // d'écraser.
      let result = await saveProjectAs(projectAtStart, liveStore.savePath, onProgress, mediaTagsAtStart, {
        workspaceDir: configuredOutputDir,
        deferWrite: isEphemeralSession,
      }, mediaLibraryPathsAtStart);
      if (!result) {
        setSaveAsProgress(null);
        return null;
      }
      if (result?.path) {
        const targetWorkspaceDir = configuredOutputDir;
        let finalMediaTags = mediaTagsAtStart;
        let finalMediaLibraryPaths = result.mediaLibraryPaths ?? mediaLibraryPathsAtStart;
        const transferResult = await maybeOfferTransferIntoProject(result.project, result.path, {
          copyEnabled: true,
          skipPrompt: isEphemeralSession,
          targetWorkspaceDir,
        });
        transferCopies = transferResult.copies ?? [];
        const transferErrors = transferResult.errors ?? [];
        if (shouldAbortEphemeralPromotion({ isEphemeralSession, transferErrors })) {
          logger.warn(`save-as:abort-ephemeral-transfer-errors count=${transferErrors.length}`);
          // Aucun fichier n'est écrit : les médias copiés avant l'erreur ne
          // seraient désignés par rien.
          await discardMediaCopies(transferCopies);
          setSaveAsProgress(null);
          setSaveToast('error');
          setTimeout(() => setSaveToast(null), 3000);
          return null;
        }
        // Le premier fichier a réconcilié aussi les médias référencés qui
        // n'étaient pas encore au catalogue en mémoire. Leurs anciennes adresses
        // ne doivent pas survivre dans le fichier final après le transfert.
        finalMediaLibraryPaths = applySessionMediaTriage({
          mediaLibraryPaths: finalMediaLibraryPaths,
          mediaTags: finalMediaTags,
          replacements: new Map((transferResult.copies ?? [])
            .map(({ from, to }) => [pathKey(from), to])),
          droppedPaths: [],
        }).mediaLibraryPaths;
        // Tri des médias de session non utilisés : après le
        // transfert des médias référencés, avant le nettoyage de la session.
        // Le tri résout tous ses échecs de copie en interne (réessayer /
        // abandonner) : à son retour, plus aucun média conservé ne dépend du
        // dossier de session. Il n'est lancé que si la session de départ est
        // encore la session courante : il trie son dossier, pas celui d'un
        // travail arrivé depuis.
        let triageResult = { changed: false };
        if (isEphemeralSession && triageSessionMedia && sessionStillCurrent()) {
          triageResult = await triageSessionMedia({
            project: transferResult.project,
            savePath: result.path,
            sessionDir: sessionAtStart.dir,
            targetWorkspaceDir,
            transferCopies: transferResult.copies ?? [],
            isSessionCurrent: sessionStillCurrent,
          });
        }
        finalMediaTags = triageResult.mediaTags ?? finalMediaTags;
        finalMediaLibraryPaths = triageResult.mediaLibraryPaths ?? finalMediaLibraryPaths;
        if (result.written === false || transferResult.changed || triageResult.changed) {
          result = await saveProject(transferResult.project, result.path, onProgress, {
            mediaTags: finalMediaTags,
            mediaLibraryPaths: finalMediaLibraryPaths,
            workspaceDir: targetWorkspaceDir,
          });
          finalMediaLibraryPaths = result.mediaLibraryPaths ?? finalMediaLibraryPaths;
        }
        transferCopiesSaved = true;
        // Même publication qu'un enregistrement en place : la copie est écrite,
        // mais elle ne réinstalle un état que si le travail visé est encore
        // celui-là — catalogue et tags compris.
        const decision = publishSaveResult({
          result,
          projectAtStart,
          // Le catalogue que le tri a lui-même posé fait partie de ce qui vient
          // d'être enregistré : c'est contre lui, et non contre le catalogue de
          // départ, que se juge une modification concurrente.
          mediaLibraryPathsAtStart: triageResult.mediaLibraryPaths ?? mediaLibraryPathsAtStart,
          savedMediaLibraryPaths: finalMediaLibraryPaths,
          savedMediaTags: finalMediaTags,
          workEpochAtStart,
          logLabel: 'save-as',
        });
        setRecentProjects(rememberRecentProject(result.project, result.path));
        // La promotion supprime un dossier de session et bascule le mode : elle
        // n'est proposée que si ce résultat concerne encore le travail et la
        // session dont il est parti. Un Save As de A qui se termine dans la
        // session B ne promeut ni ne nettoie B (F-04).
        // La même session peut avoir reçu du travail pendant le transfert.
        // Recontrôler aussi après les attentes du nettoyage : le résultat
        // enregistré ne décrit pas les dépendances d'une mutation plus récente.
        const isPublicationCurrent = () => {
          const current = liveStoreRef.current;
          return sessionStillCurrent()
            && current.workEpochRef.current === workEpochAtStart
            && createWorkSnapshot(result.project, finalMediaLibraryPaths, finalMediaTags)
              === publishedWorkSnapshot({
                projectStillCurrent: isSaveInputStillCurrent(projectAtStart, current.project),
                resultProject: result.project,
                currentProject: current.project,
                mediaLibraryPaths: mediaLibraryPathsRef.current,
                mediaTags: current.mediaTags,
              });
        };
        const promote = decision === SAVE_PUBLICATION.CURRENT && isPublicationCurrent();
        if (!promote && sessionAtStart) {
          logger.warn(`save-as:promotion-skipped decision=${decision} session-current=${sessionStillCurrent()}`);
        }
        if (promote) {
          // Le projet courant désigne désormais les copies durables ; les
          // étapes d'annulation suivent la même relocalisation, avant que la
          // promotion ne supprime les originaux de session.
          relocateHistoryMedia(liveStoreRef.current, [
            ...transferCopies.map(({ from, to }) => [pathKey(from), to]),
            ...(triageResult.replacements ?? new Map()),
          ]);
        }
        await onProjectSaved?.(result, {
          promote,
          session: sessionAtStart,
          isPublicationCurrent,
          workspaceDir: configuredOutputDir,
          cleanupSession: transferErrors.length === 0,
        });
        setSaveToast('ok');
        setTimeout(() => setSaveToast(null), 2000);
        setSaveAsProgress(prev => prev ? { ...prev, complete: true } : null);
        setTimeout(() => setSaveAsProgress(null), 1800);
        return result.path;
      }
      setSaveAsProgress(null);
      return null;
    } catch (e) {
      logger.error('save-as:error', e);
      if (!transferCopiesSaved) {
        // Le tri a pu re-pointer catalogue et tags vers ces copies : l'état en
        // mémoire les désigne alors, elles restent.
        const live = liveStoreRef.current;
        await discardMediaCopies(transferCopies, {
          keepPaths: [...(mediaLibraryPathsRef.current ?? []), ...Object.keys(live.mediaTags ?? {})],
        });
      }
      setSaveAsProgress(null);
      setSaveToast('error');
      showErrorDialog?.({
        title: 'Enregistrement impossible',
        message: `Le projet n'a pas pu être enregistré : ${e?.message ?? e}`,
      });
      setTimeout(() => setSaveToast(null), 3000);
      return null;
    }
  }, [
    captureWorkSession,
    configuredWorkspaceDir,
    isWorkSessionCurrent,
    mediaLibraryPathsRef,
    maybeOfferTransferIntoProject,
    onProjectSaved,
    publishSaveResult,
    setRecentProjects,
    setSaveToast,
    showErrorDialog,
    triageSessionMedia,
  ]);

  const handleSave = useCallback(() => (
    store.savePath ? handleSaveProject() : handleSaveProjectAs()
  ), [handleSaveProject, handleSaveProjectAs, store.savePath]);

  return {
    saveProgress,
    saveAsProgress,
    setSaveProgress,
    setSaveAsProgress,
    handleSaveProject,
    handleSaveProjectAs,
    handleSave,
    persistProjectSnapshot,
  };
}
