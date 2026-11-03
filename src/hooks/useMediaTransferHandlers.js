import { presentUserMessage } from '../i18n/userMessage.js';
import { beginProjectMediaOutput } from '../store/projectMediaOutput';
import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ask } from '@tauri-apps/plugin-dialog';
import {
  collectTransferableProjectFiles,
  copyMediaToWorkspace,
  getWorkspaceDir,
  isAlreadyManagedFile,
  transferProjectFilesToProject,
} from '../store/projectIO';
import { findEntryById } from '../store/projectModel';
import { pathKey } from '../utils/fileUtils';
import { FICHIERS_IMPORTES } from '../store/workspaceDirs';
import { keepFolderPackInProject } from '../utils/packFolder';
import { buildTransferPromptSignature } from '../store/projectHelpers';

import { translateMedia } from '../i18n/mediaPresentation.js';
import { logger } from '../utils/logger';

export function useMediaTransferHandlers({
  store,
  mediaStorageRef = null,
  sessionModeRef = null,
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
}) {
  // `artifactCopies` reçoit les copies annexes — la source d'une image éditée —
  // pour qu'un appelant dont le geste échoue puisse tout retirer
  // (`discardMediaCopies`). La copie principale est le chemin rendu.
  const maybeCopyToProject = useCallback(async (filePath, { artifactCopies = null, mediaStorage = null, mediaOutput = null } = {}) => {
    if (!copyImportedFilesEnabled) return filePath;
    const captured = mediaStorage ?? { ...(mediaStorageRef?.current ?? {}), root: workspaceDirRef.current, storage: (store.readProject?.() ?? store.project).storage, ephemeral: sessionModeRef?.current === 'ephemeral' };
    const ws = captured.root;
    if (isAlreadyManagedFile(filePath, ws, savePathRef.current)) return filePath;
    try {
      const targetWorkspace = ws || await getWorkspaceDir();
      if (!workspaceDir) setWorkspaceDirState(targetWorkspace);
      return await copyMediaToWorkspace(
        filePath,
        targetWorkspace,
        FICHIERS_IMPORTES,
        { ...captured, root: targetWorkspace },
        { artifactCopies, mediaOutput },
      );
    } catch (e) {
      logger.error('media-transfer:copy-to-project-error', e);
      setSaveToast?.('error');
      setTimeout(() => setSaveToast?.(null), 3000);
      return filePath;
    }
  }, [mediaStorageRef, sessionModeRef, copyImportedFilesEnabled, savePathRef, setSaveToast, setWorkspaceDirState, store, workspaceDir, workspaceDirRef]);

  const copyGeneratedMediaToProject = useCallback(async (filePath, { mediaStorage = null, mediaOutput = null } = {}) => {
    const captured = mediaStorage ?? { ...(mediaStorageRef?.current ?? {}), root: workspaceDirRef.current, storage: (store.readProject?.() ?? store.project).storage, ephemeral: sessionModeRef?.current === 'ephemeral' };
    const ws = captured.root;
    if (isAlreadyManagedFile(filePath, ws, savePathRef.current)) return filePath;
    try {
      const targetWorkspace = ws || await getWorkspaceDir();
      if (!workspaceDir) setWorkspaceDirState(targetWorkspace);
      return await copyMediaToWorkspace(filePath, targetWorkspace, FICHIERS_IMPORTES, { ...captured, root: targetWorkspace }, { mediaOutput });
    } catch (e) {
      logger.error('media-transfer:copy-generated-to-project-error', e);
      setSaveToast?.('error');
      setTimeout(() => setSaveToast?.(null), 3000);
      return filePath;
    }
  }, [mediaStorageRef, sessionModeRef, savePathRef, setSaveToast, setWorkspaceDirState, store, workspaceDir, workspaceDirRef]);

  const keepFolderPack = useCallback(async (folderPath, { destination, isCurrent, apply }) => {
    const epoch = store.workEpochRef.current;
    const mediaStorage = {
      ...destination, storage: { ...destination.storage },
    };
    const current = () => {
      const project = store.readProject?.() ?? store.project;
      return store.workEpochRef.current === epoch
        && project.storage.workId === mediaStorage.storage.workId
        && (mediaStorage.ephemeral || project.storage.folder === mediaStorage.storage.folder)
        && workspaceDirRef.current === mediaStorage.root
        && (sessionModeRef.current === 'ephemeral') === mediaStorage.ephemeral
        && isCurrent();
    };
    // Le dialogue de choix peut avoir laissé terminer une promotion avant
    // même le prochain rendu React : sa destination initiale fait encore foi.
    if (!current()) return null;
    // Une sauvegarde peut avoir lieu, mais ne peut ni promouvoir/nettoyer la
    // session ni déplacer cette sortie avant son affectation (ou son retrait).
    const mediaOutput = beginProjectMediaOutput(mediaStorage);
    try {
      return await keepFolderPackInProject(folderPath,
        staged => copyGeneratedMediaToProject(staged, { mediaStorage, mediaOutput }), {
          workspaceDir: mediaStorage.root, isCurrent: current, apply,
        });
    } finally { mediaOutput.release(); }
  }, [copyGeneratedMediaToProject, sessionModeRef, store, workspaceDirRef]);

  const dropOnNode = useCallback(async ({ nodeId, nodeType, path, paths, kind, clipboardMode }) => {
    if (kind !== 'audio' && kind !== 'image') return;
    const sourcePaths = (Array.isArray(paths) && paths.length > 0 ? paths : [path]).filter(Boolean);
    if (sourcePaths.length === 0) return;
    const epoch = store.workEpochRef?.current;
    const mediaStorage = { ...(mediaStorageRef?.current ?? {}), root: workspaceDirRef.current, storage: (store.readProject?.() ?? store.project).storage, ephemeral: sessionModeRef?.current === 'ephemeral' };
    const mediaOutput = mediaStorage.root ? beginProjectMediaOutput(mediaStorage) : null;
    try {
      logger.info('media-transfer:drop', {
        nodeId,
        nodeType,
        kind,
        count: sourcePaths.length,
        clipboardMode: clipboardMode || 'copy',
      });
      const finalPaths = [];
      for (const sourcePath of sourcePaths) {
        finalPaths.push(await maybeCopyToProject(sourcePath, { mediaStorage, mediaOutput }));
      }
      if (epoch != null && store.workEpochRef.current !== epoch) return;
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
        // Remplacement de l'audio principal : on garde l'ancien fichier visible
        // dans le gestionnaire de médias (« Non utilisés ») au lieu de le rendre
        // orphelin invisible sur le disque.
        const previousAudio = findEntryById(store.project, nodeId)?.audio;
        store.updateItem(nodeId, { audio: finalPaths[0] });
        if (previousAudio && pathKey(previousAudio) !== pathKey(finalPaths[0])) {
          addPathsToMediaLibrary?.([previousAudio]);
        }
      }
    } finally { mediaOutput?.release(); }
  }, [addPathsToMediaLibrary, maybeCopyToProject, mediaStorageRef, sessionModeRef, store, workspaceDirRef]);

  const notifyCutPaste = useCallback(({ path, kind } = {}) => {
    if (!path) return;
    logger.info('media-transfer:cut-paste', { path, kind });
    store.removeMediaReferences(path);
  }, [store]);

  const extractAudioEmbeddedImage = useCallback(async (audioPath) => {
    if (!audioPath) return null;
    try {
      return await invoke('extract_audio_embedded_image', { audioPath });
    } catch (e) {
      logger.warn('media-transfer:extract-embedded-image-error', audioPath, e);
      return null;
    }
  }, []);

  const maybeOfferTransferIntoProject = useCallback(async (project, savePath, options = {}) => {
    const {
      forcePrompt = false,
      copyEnabled = copyImportedFilesEnabled,
      skipPrompt = false,
      targetWorkspaceDir = null,
      sourceSessionDir = null,
      mediaStorage = null,
      // Enregistrement automatique : aucune question ne s'ouvre. Un transfert
      // qui aurait été proposé est seulement signalé (`deferred`) — copier
      // sans l'accord de l'auteur n'est pas permis, et l'appelant doit alors
      // laisser le projet « modifié » jusqu'au prochain enregistrement manuel.
      silent = false,
    } = options;
    if (!copyEnabled || !savePath) return { project, changed: false, copies: [] };

    const candidates = collectTransferableProjectFiles(project, savePath, pathAudit);
    if (candidates.length === 0) {
      dismissedTransferPromptRef.current = null;
      return { project, changed: false, copies: [] };
    }

    const signature = buildTransferPromptSignature(savePath, candidates);
    if (!forcePrompt && dismissedTransferPromptRef.current === signature) {
      return { project, changed: false, copies: [] };
    }
    if (silent) return { project, changed: false, copies: [], deferred: true };

    // Dialogue natif : textes résolus dans la langue active au moment de l'ouverture.
    const sample = candidates.slice(0, 5).map((candidate) => `• ${candidate.filename}`).join('\n');
    const suffix = candidates.length > 5
      ? `\n• ${translateMedia('native:transfer.prompt.more', { count: candidates.length - 5 })}`
      : '';
    const confirmed = skipPrompt || (await ask(
        translateMedia('native:transfer.prompt.message', { count: candidates.length, files: `${sample}${suffix}` }),
        {
          title: translateMedia('native:transfer.prompt.title'),
          kind: 'warning',
          okLabel: translateMedia('native:transfer.prompt.confirm'),
          cancelLabel: translateMedia('native:transfer.prompt.later'),
        }
      ));

    if (!confirmed) {
      dismissedTransferPromptRef.current = signature;
      return { project, changed: false, copies: [] };
    }

    const artifactCopies = [];
    const knownCopies = new Map();
    // Un Save As transmet déjà le projet et le chemin nouvellement nommés. Ne pas
    // relire le store précédent ici : pendant une promotion de session, il peut
    // encore porter le nom technique du snapshot de récupération.
    const projectPrefix = { ...(mediaStorage ?? { root: targetWorkspaceDir || workspaceDir, storage: project.storage, ephemeral: false }), sessionRoot: sourceSessionDir };
    const transferResult = await transferProjectFilesToProject(
      project,
      savePath,
      async (sourcePath) => {
        const targetWorkspace = targetWorkspaceDir || workspaceDir || await getWorkspaceDir();
        if (!targetWorkspaceDir && !workspaceDir) setWorkspaceDirState(targetWorkspace);
        return copyMediaToWorkspace(
          sourcePath,
          targetWorkspace,
          FICHIERS_IMPORTES,
          projectPrefix,
          { artifactCopies, knownCopies },
        );
      },
      pathAudit,
    );

    dismissedTransferPromptRef.current = null;

    if (transferResult.errors.length > 0) {
      const errors = transferResult.errors.slice(0, 5);
      showErrorDialog({
        get title() { return translateMedia('media:transfer.incomplete.title'); },
        message: { parts: [{ key: 'media:transfer.incomplete.message' }, '\n\n', ...errors.flatMap((error, index) => [
          index ? '\n• ' : '• ',
          { get parts() { return [error.label]; } },
          '\n  ', { userMessage: error.userMessage },
        ])] },
        technicalDetail: errors.map((error) => presentUserMessage(error.userMessage).technicalDetail).filter(Boolean).join('\n'),
      });
    }

    return {
      project: transferResult.project,
      changed: transferResult.copiedCount > 0,
      copies: [...transferResult.copies, ...artifactCopies],
      errors: transferResult.errors,
    };
  }, [
    copyImportedFilesEnabled,
    dismissedTransferPromptRef,
    pathAudit,
    setWorkspaceDirState,
    showErrorDialog,
    workspaceDir,
  ]);

  const handleCopyImportedFilesChange = useCallback(async (enabled) => {
    setCopyImportedFilesEnabled(enabled);
    if (!enabled || !store.savePath) return;

    try {
      const transferResult = await maybeOfferTransferIntoProject(store.project, store.savePath, {
        forcePrompt: true,
        copyEnabled: enabled,
      });
      if (transferResult.changed) {
        await persistProjectSnapshotRef.current?.(transferResult.project, store.savePath);
      }
    } catch (e) {
      logger.error('media-transfer:copy-imported-files-error', e);
      setSaveToast('error');
      setTimeout(() => setSaveToast(null), 3000);
    }
  }, [
    maybeOfferTransferIntoProject,
    persistProjectSnapshotRef,
    setCopyImportedFilesEnabled,
    setSaveToast,
    store,
  ]);

  return {
    maybeCopyToProject,
    copyGeneratedMediaToProject,
    keepFolderPack,
    dropOnNode,
    notifyCutPaste,
    extractAudioEmbeddedImage,
    maybeOfferTransferIntoProject,
    handleCopyImportedFilesChange,
  };
}
