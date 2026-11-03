import { claimProjectAccess, installProjectAccess, releaseProjectAccess } from '../store/projectSessionAccess.js';
import { presentUserMessage } from '../i18n/userMessage.js';
import { productionRef, translateProduction } from '../i18n/productionPresentation.js';
import { isProjectMediaOutputBusy } from '../store/projectMediaOutput';
import { prepareProjectStorageSave, remapStoragePath, relocateStorageProject, relocateStorageTags } from '../store/projectStorageSave';
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

function relocateHistoryMedia(store, replacementEntries, storage = null, moves = []) {
  const replacements = new Map(replacementEntries.filter(([from, to]) => from && to));
  if (replacements.size === 0 && !storage) return;
  store.relocateHistory((original) => {
    const project = storage ? relocateStorageProject(original, moves, storage) : original;
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
  mediaLibraryCountRef = null,
  setSaveToast,
  showErrorDialog = null,
  setRecentProjects,
  maybeOfferTransferIntoProject,
  triageSessionMedia = null,
  onProjectSaved = null,
  onMediaPathsRelocated = null,
}) {
  const [saveProgress, setSaveProgress] = useState(null); // null | { lines: string[], complete: boolean }
  const [saveAsProgress, setSaveAsProgress] = useState(null);
  const liveStoreRef = useRef(store);
  liveStoreRef.current = store;
  // Écriture de projet en cours : `{ kind, done }`. Les quatre écritures du
  // hook — enregistrement manuel, automatique, copie sous et instantané
  // d'après import/transfert — passent toutes par ce créneau unique. Sans lui,
  // le `rename` d'une écriture partie plus tôt pouvait arriver après celui
  // d'une plus récente et remettre l'ancien contenu dans le fichier, alors que
  // la mémoire, publiée par la plus récente, se disait enregistrée.
  const saveSlotRef = useRef(null);
  // Dernier chemin publié, tant que le rendu ne l'a pas encore installé :
  // `{ path, epoch, previous }`. Un Ctrl+S qui attendait la fin d'un
  // « Enregistrer sous » relirait sinon l'ancien `savePath` du rendu et
  // réécrirait l'ancien fichier.
  const publishedPathRef = useRef(null);
  const readLiveSavePath = useCallback((liveStore) => {
    const published = publishedPathRef.current;
    if (published
      && published.epoch === liveStore.workEpochRef.current
      && liveStore.savePath === published.previous) {
      return published.path;
    }
    return liveStore.savePath;
  }, []);

  // Prend le créneau. L'enregistrement automatique ne patiente jamais : déjà
  // occupé, il rend `null` et la prochaine échéance s'en charge. Les autres
  // attendent la fin de l'écriture en cours puis s'exécutent : un Ctrl+S ou la
  // garde de fermeture ne sont jamais ignorés en silence. Aucune écriture ne
  // prend le créneau depuis une autre qui le tient : l'attente ne peut pas se
  // boucler sur elle-même.
  const acquireSaveSlot = useCallback(async (kind, { skipIfBusy = false } = {}) => {
    while (isSavingRef.current) {
      const pending = saveSlotRef.current;
      if (skipIfBusy || !pending) {
        logger.info(`save:slot-busy kind=${kind} holder=${pending?.kind ?? 'unknown'}`);
        return null;
      }
      await pending.done;
    }
    isSavingRef.current = true;
    let settle;
    const slot = { kind, done: new Promise((resolve) => { settle = resolve; }) };
    saveSlotRef.current = slot;
    return () => {
      if (saveSlotRef.current === slot) saveSlotRef.current = null;
      isSavingRef.current = false;
      settle();
    };
  }, [isSavingRef]);

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
  const publishSaveResult = useCallback(async ({
    result: written,
    projectAtStart,
    mediaLibraryPathsAtStart,
    savedMediaLibraryPaths,
    savedMediaTags,
    workEpochAtStart,
    logLabel,
    // `false` : le fichier est valide et devient le chemin courant, mais la
    // mémoire n'est pas déclarée enregistrée (un enregistrement automatique
    // qui a dû différer une décision de l'auteur).
    markSaved = true,
  }) => {
    // Le store n'installe jamais le projet écrit tel quel : il le normalise
    // (séparateurs de chemins d'une image rangée, par exemple). La signature
    // publiée, le projet courant publié et la synchronisation portent donc tous
    // sur ce même projet normalisé, sans quoi le travail à peine enregistré
    // paraîtrait modifié.
    const result = { ...written, project: normalizeWorkProject(written.project) };
    let accessError = null;
    if (written.path && liveStoreRef.current.workEpochRef.current === workEpochAtStart) {
      try {
        const token = await claimProjectAccess('open', written.path);
        if (liveStoreRef.current.workEpochRef.current === workEpochAtStart) { await installProjectAccess(token, result.project, () => liveStoreRef.current.workEpochRef.current === workEpochAtStart); }
        else { await releaseProjectAccess(token); }
      } catch (error) { accessError = error; }
    }
    const currentStore = liveStoreRef.current;
    const replaced = currentStore.workEpochRef.current !== workEpochAtStart;
    // Le projet **vivant**, pas le dernier rendu : un `setProject` pas encore
    // rendu (fin d'une génération, par exemple) y est déjà. Lu ici et appliqué
    // sans attente, la réinstallation est un compare-and-swap : elle n'a lieu
    // que si la mémoire est encore exactement le projet confié à l'écriture.
    const liveProject = currentStore.readProject?.() ?? currentStore.project;
    const projectStillCurrent = isSaveInputStillCurrent(projectAtStart, liveProject);
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
    const classified = classifySavePublication({
      replaced,
      savedSnapshot,
      currentSnapshot: replaced ? null : publishedWorkSnapshot({
        projectStillCurrent,
        resultProject: result.project,
        currentProject: liveProject,
        mediaLibraryPaths: mediaLibraryPathsRef.current,
        mediaTags: currentStore.readMediaTags?.() ?? currentStore.mediaTags,
      }),
    });
    const decision = !markSaved && classified === SAVE_PUBLICATION.CURRENT
      ? SAVE_PUBLICATION.STALE
      : classified;
    if (decision !== SAVE_PUBLICATION.REPLACED && result.path) {
      publishedPathRef.current = {
        path: result.path,
        epoch: workEpochAtStart,
        previous: currentStore.savePath,
      };
    }
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
      logger.warn(`${logLabel}:not-published decision=${decision} path='${result.path}'${markSaved ? '' : ' deferred=true'}`);
    }
    if (accessError) {
      logger.warn('save:project-access', accessError);
      showErrorDialog?.({ message: presentUserMessage(accessError).message, technicalDetail: presentUserMessage(accessError).technicalDetail });
    }
    return { decision, savedSnapshot };
  }, [autoSaveSnapshotRef, mediaLibraryPathsRef, savedSnapshotRef, setMediaLibraryPaths, showErrorDialog]);

  const commitStorageResult = useCallback((transaction, result, projectAtStart, libraryAtStart, epoch, replacementEntries = []) => {
    if (!transaction?.finalized && (!replacementEntries.length || !result.project.storage)) return { projectAtStart, mediaLibraryPathsAtStart: libraryAtStart };
    transaction?.commit();
    const storage = transaction?.storage ?? result.project.storage;
    const replacements = new Map(replacementEntries);
    const remap = (path) => replacements.get(pathKey(path)) ?? remapStoragePath(path, transaction.moves);
    onMediaPathsRelocated?.(remap);
    const live = liveStoreRef.current;
    if (live.workEpochRef.current !== epoch) return { projectAtStart, mediaLibraryPathsAtStart: libraryAtStart };
    const current = live.readProject?.() ?? live.project;
    const stillCurrent = isSaveInputStillCurrent(projectAtStart, current);
    live.syncProjectWithoutHistory(stillCurrent ? result.project : {
      ...mapProjectMediaPaths(current, remap), storage,
    });
    const currentLibrary = mediaLibraryPathsRef.current;
    const libraryStillCurrent = isSaveInputStillCurrent(libraryAtStart, currentLibrary);
    const relocatedLibrary = currentLibrary.map(remap);
    mediaLibraryPathsRef.current = relocatedLibrary;
    setMediaLibraryPaths(relocatedLibrary);
    const tags = relocateStorageTags(live.readMediaTags?.() ?? live.mediaTags, transaction.moves);
    live.setMediaTags(Object.fromEntries(Object.entries(tags).map(([path, values]) => [remap(path), values])));
    relocateHistoryMedia(live, replacementEntries, storage, transaction.moves);
    return {
      projectAtStart: stillCurrent ? (live.readProject?.() ?? live.project) : projectAtStart,
      mediaLibraryPathsAtStart: libraryStillCurrent ? relocatedLibrary : libraryAtStart.map(remap),
    };
  }, [mediaLibraryPathsRef, onMediaPathsRelocated, setMediaLibraryPaths]);

  const writeProjectSnapshot = useCallback(async (project, savePath) => {
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
    const { decision } = await publishSaveResult({
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

  // Un instantané suit un import ou un transfert : il attend son tour comme un
  // enregistrement manuel, pour ne jamais être recouvert par une écriture
  // partie avant lui.
  const persistProjectSnapshot = useCallback(async (project, savePath) => {
    const release = await acquireSaveSlot('snapshot');
    if (!release) return null;
    try {
      return await writeProjectSnapshot(project, savePath);
    } finally {
      release();
    }
  }, [acquireSaveSlot, writeProjectSnapshot]);

  const handleSaveProject = useCallback(async ({
    silent = false,
    projectOverride = null,
    mediaTagsOverride = null,
    mediaLibraryPathsOverride = null,
    returnResult = false,
  } = {}) => {
    // Serializes saves inside the app; external edits to the same .mbah remain
    // outside this guard and are handled by the next explicit load/save cycle.
    // Un enregistrement manuel attend la fin de l'écriture en cours ; un
    // enregistrement automatique n'attend pas (la prochaine échéance s'en
    // chargera).
    const release = await acquireSaveSlot(silent ? 'auto' : 'manual', { skipIfBusy: silent });
    if (!release) return null;
    let storageTransaction = null;
    let storageWritten = false;
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
    // Le projet vivant : l'écriture part de la dernière mutation, même pas
    // encore rendue, et la publication la reconnaîtra par identité.
    const projectToSave = projectOverride ?? liveStore.readProject?.() ?? liveStore.project;
    let mediaTagsToSave = mediaTagsOverride ?? liveStore.readMediaTags?.() ?? liveStore.mediaTags;
    let mediaLibraryPathsToSave = mediaLibraryPathsOverride ?? mediaLibraryPathsRef.current;
    const libraryAtStart = mediaLibraryPathsToSave;
    const targetPath = readLiveSavePath(liveStore);
    if (!silent && (!targetPath || captureWorkSession?.()?.mode === 'ephemeral')) {
      release();
      return handleSaveProjectAs({ targetPath });
    }
    logger.info(`save:start kind=${silent ? 'auto' : 'manual'} hasPath=${!!targetPath} projectType=${projectToSave?.projectType || 'none'} entries=${projectToSave?.rootEntries?.length ?? 0}`);
    try {
      // Un savePath survit hors historique. Si un état invalide atteignait le
      // store, il ne doit jamais pouvoir écraser le dernier fichier valide.
      assertProjectCanSaveInPlace(projectToSave, targetPath);
      storageTransaction = await prepareProjectStorageSave({
        project: projectToSave, root: configuredWorkspaceDir || await ensureWorkspaceDir(), path: targetPath, silent,
      });
      mediaTagsToSave = relocateStorageTags(mediaTagsToSave, storageTransaction.moves);
      mediaLibraryPathsToSave = mediaLibraryPathsToSave.map((path) => remapStoragePath(path, storageTransaction.moves));
      if (storageTransaction.deferred) onProgress(productionRef('production:save.media.deferred'));
      let result = await saveProject(storageTransaction.project, targetPath, onProgress, {
        // `autosave` : ni dernier dossier mémorisé, ni renommage d'après le
        // fichier, refus d'un projet vide.
        autosave: silent,
        mediaStorage: storageTransaction.mediaContext,
        // Toujours le fichier du projet : les images temporaires y sont
        // copiées dans l'emplacement de travail, silencieusement ou non, faute
        // de quoi il désignerait le cache purgeable de l'application.
        persistTempImages: true,
        // Toujours le fichier du projet (chemin explicite ou choisi) : même
        // silencieuse, cette écriture active les suivis demandés.
        announceSubscriptions: true,
        backupLimit: autoSaveEnabled ? autoSaveBackupLimit : 0,
        mediaTags: mediaTagsToSave,
        mediaLibraryPaths: mediaLibraryPathsToSave,
        // Même inventaire que la décision de l'échéance : sans lui, la garde
        // « projet vide » refusait un projet dont seuls des médias comptent.
        totalMediaCount: mediaLibraryCountRef?.current ?? 0,
        workspaceDir: configuredWorkspaceDir || null,
      });
      if (!result) {
        setSaveProgress(null);
        return null;
      }
      if (result?.path) {
        storageWritten = true;
        let publicationInputs = commitStorageResult(storageTransaction, result, projectToSave, libraryAtStart, workEpochAtStart);
        // En silencieux, le transfert vers l'emplacement de travail n'est pas
        // proposé : il demande l'accord de l'auteur. Les fichiers restent liés
        // à leur emplacement actuel — rien n'est perdu — mais le projet n'est
        // pas déclaré enregistré, pour que le prochain enregistrement manuel
        // (ou la garde de fermeture) pose la question.
        const transferResult = await maybeOfferTransferIntoProject(
          result.project,
          result.path,
          { silent, mediaStorage: storageTransaction.mediaContext },
        );
        if (transferResult.changed) {
          const relocated = applySessionMediaTriage({
            mediaLibraryPaths: mediaLibraryPathsToSave, mediaTags: mediaTagsToSave,
            replacements: new Map((transferResult.copies ?? []).map(({ from, to }) => [pathKey(from), to])),
            droppedPaths: [],
          });
          mediaTagsToSave = relocated.mediaTags;
          mediaLibraryPathsToSave = relocated.mediaLibraryPaths;
          try {
            result = await saveProject(transferResult.project, result.path, onProgress, {
              mediaStorage: storageTransaction.mediaContext,
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
        publicationInputs = commitStorageResult(storageTransaction, result, publicationInputs.projectAtStart, publicationInputs.mediaLibraryPathsAtStart, workEpochAtStart, (transferResult.copies ?? []).map(({ from, to }) => [pathKey(from), to]));
        const { savedSnapshot: writtenSnapshot } = await publishSaveResult({
          result,
          ...publicationInputs,
          savedMediaLibraryPaths: result.mediaLibraryPaths ?? mediaLibraryPathsToSave,
          savedMediaTags: mediaTagsToSave,
          workEpochAtStart,
          logLabel: silent ? 'autosave' : 'save',
          markSaved: !transferResult.deferred,
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
        // L'enregistrement automatique reçoit la signature réellement écrite :
        // c'est elle, réconciliation du catalogue comprise, que la prochaine
        // échéance comparera.
        if (silent) return { status: 'saved', path: result.path, writtenSnapshot };
        return returnResult ? result : result.path;
      }
      setSaveProgress(null);
      return null;
    } catch (e) {
      logger.error(`save:error kind=${silent ? 'auto' : 'manual'}`, e);
      if (storageTransaction && !storageWritten) {
        try { await storageTransaction.rollback(); } catch (rollbackError) { e = productionRef('production:save.rollback.message', { reason: { userMessage: e }, rollback: { userMessage: rollbackError } }); }
      }
      // Un enregistrement automatique en échec se signale par la pastille et le
      // journal seulement : une boîte modale reviendrait à chaque échéance.
      // Le projet reste « modifié », la garde de fermeture le rattrape.
      if (!silent) {
        showErrorDialog?.({
          get title() { return translateProduction('production:save.error.title'); },
          technicalDetail: presentUserMessage(e).technicalDetail,
          message: productionRef('production:save.error.message', { reason: { userMessage: e } }),
        });
      }
      setSaveProgress(null);
      setSaveToast('error');
      setTimeout(() => setSaveToast(null), 3000);
      return silent ? { status: 'failed', path: targetPath ?? null } : null;
    } finally {
      storageTransaction?.release();
      release();
    }
  }, [
    commitStorageResult,
    acquireSaveSlot,
    captureWorkSession,
    autoSaveBackupLimit,
    autoSaveEnabled,
    configuredWorkspaceDir,
    maybeOfferTransferIntoProject,
    mediaLibraryCountRef,
    mediaLibraryPathsRef,
    publishSaveResult,
    setRecentProjects,
    setSaveToast,
    showErrorDialog,
    onProjectSaved,
  ]);

  const handleSaveProjectAs = useCallback(async ({ targetPath = null } = {}) => {
    let storageTransaction = null;
    let storageWritten = false;
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
    // L'écriture en cours finit d'abord, et aucune ne démarre pendant la
    // copie : terminé après elle, un enregistrement automatique republierait
    // l'ancien chemin par-dessus celui que l'auteur vient de choisir.
    const release = await acquireSaveSlot('save-as');
    if (!release) return null;
    try {
      const liveStore = liveStoreRef.current;
      const workEpochAtStart = liveStore.workEpochRef.current;
      const projectAtStart = liveStore.readProject?.() ?? liveStore.project;
      const mediaTagsAtStart = liveStore.readMediaTags?.() ?? liveStore.mediaTags;
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
      let result = await saveProjectAs(projectAtStart, readLiveSavePath(liveStore), onProgress, mediaTagsAtStart, {
        workspaceDir: configuredOutputDir,
        deferWrite: true,
        chosenPath: targetPath,
      }, mediaLibraryPathsAtStart);
      if (!result) {
        setSaveAsProgress(null);
        return null;
      }
      if (result?.path) {
        const targetWorkspaceDir = configuredOutputDir;
        storageTransaction = await prepareProjectStorageSave({
          project: result.project, root: configuredOutputDir, path: result.path, ephemeral: isEphemeralSession,
        });
        result.project = storageTransaction.project;
        result.mediaLibraryPaths = result.mediaLibraryPaths?.map((path) => remapStoragePath(path, storageTransaction.moves));
        if (storageTransaction.deferred) onProgress(productionRef('production:save.media.deferred'));
        let finalMediaTags = relocateStorageTags(mediaTagsAtStart, storageTransaction.moves);
        let finalMediaLibraryPaths = result.mediaLibraryPaths ?? mediaLibraryPathsAtStart;
        const transferResult = await maybeOfferTransferIntoProject(result.project, result.path, {
          copyEnabled: true,
          skipPrompt: isEphemeralSession,
          targetWorkspaceDir,
          sourceSessionDir: isEphemeralSession ? sessionAtStart.dir : null,
          mediaStorage: storageTransaction.mediaContext,
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
        const relocatedCatalogue = applySessionMediaTriage({
          mediaLibraryPaths: finalMediaLibraryPaths,
          mediaTags: finalMediaTags,
          replacements: new Map((transferResult.copies ?? [])
            .map(({ from, to }) => [pathKey(from), to])),
          droppedPaths: [],
        });
        finalMediaLibraryPaths = relocatedCatalogue.mediaLibraryPaths;
        finalMediaTags = relocatedCatalogue.mediaTags;
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
            mediaStorage: storageTransaction.mediaContext,
            transferCopies: transferResult.copies ?? [],
            isSessionCurrent: sessionStillCurrent,
          });
        }
        finalMediaTags = triageResult.mediaTags ?? finalMediaTags;
        finalMediaLibraryPaths = triageResult.mediaLibraryPaths ?? finalMediaLibraryPaths;
        if (result.written === false || transferResult.changed || triageResult.changed) {
          result = await saveProject(transferResult.project, result.path, onProgress, {
            mediaStorage: storageTransaction.mediaContext,
            mediaTags: finalMediaTags,
            mediaLibraryPaths: finalMediaLibraryPaths,
            workspaceDir: targetWorkspaceDir,
          });
          finalMediaLibraryPaths = result.mediaLibraryPaths ?? finalMediaLibraryPaths;
        }
        transferCopiesSaved = true;
        storageWritten = true;
        const publicationInputs = commitStorageResult(storageTransaction, result, projectAtStart,
          triageResult.mediaLibraryPaths ?? mediaLibraryPathsAtStart, workEpochAtStart, [
            ...transferCopies.map(({ from, to }) => [pathKey(from), to]),
            ...(triageResult.replacements ?? new Map()),
          ]);
        // Même publication qu'un enregistrement en place : la copie est écrite,
        // mais elle ne réinstalle un état que si le travail visé est encore
        // celui-là — catalogue et tags compris.
        const { decision } = await publishSaveResult({
          result,
          projectAtStart: publicationInputs.projectAtStart,
          // Le catalogue que le tri a lui-même posé fait partie de ce qui vient
          // d'être enregistré : c'est contre lui, et non contre le catalogue de
          // départ, que se juge une modification concurrente.
          mediaLibraryPathsAtStart: publicationInputs.mediaLibraryPathsAtStart,
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
                projectStillCurrent: isSaveInputStillCurrent(publicationInputs.projectAtStart, current.readProject?.() ?? current.project),
                resultProject: result.project,
                currentProject: current.readProject?.() ?? current.project,
                mediaLibraryPaths: mediaLibraryPathsRef.current,
                mediaTags: current.readMediaTags?.() ?? current.mediaTags,
              });
        };
        const promote = decision === SAVE_PUBLICATION.CURRENT && isPublicationCurrent()
          && !isProjectMediaOutputBusy(result.project.storage?.workId);
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
      if (storageTransaction && !storageWritten) {
        try { await storageTransaction.rollback(); } catch (rollbackError) { e = productionRef('production:save.rollback.message', { reason: { userMessage: e }, rollback: { userMessage: rollbackError } }); }
      }
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
        get title() { return translateProduction('production:save.error.title'); },
          technicalDetail: presentUserMessage(e).technicalDetail,
        message: productionRef('production:save.error.message', { reason: { userMessage: e } }),
      });
      setTimeout(() => setSaveToast(null), 3000);
      return null;
    } finally {
      storageTransaction?.release();
      release();
    }
  }, [
    commitStorageResult,
    acquireSaveSlot,
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

  // Bouton, Ctrl+S, garde de fermeture : enregistrement manuel complet, ou
  // « Enregistrer sous » pour un projet sans fichier. Seul l'enregistrement
  // automatique passe `{ silent: true }` — testé strictement, un événement de
  // clic reçu en argument n'en fait jamais un. Il ne vise que le fichier
  // courant, relu au moment de l'appel, et n'ouvre jamais de dialogue de
  // fichier : sans chemin, il ne fait rien.
  const handleSave = useCallback((options) => {
    if (options?.silent === true) {
      return readLiveSavePath(liveStoreRef.current) ? handleSaveProject({ silent: true }) : Promise.resolve(null);
    }
    return readLiveSavePath(liveStoreRef.current) ? handleSaveProject() : handleSaveProjectAs();
  }, [handleSaveProject, handleSaveProjectAs, readLiveSavePath]);

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
