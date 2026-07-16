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
import { KEYS, read as readSetting } from '../store/persistentSettings';
import { FICHIERS_IMPORTES } from '../store/workspaceDirs';
import { buildTransferPromptSignature } from '../store/projectHelpers';
import { getProjectFilePrefix } from '../utils/projectPrefix';
import { formatFrenchCount } from '../utils/frenchText.js';
import { logger } from '../utils/logger';

export function useMediaTransferHandlers({
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
}) {
  const maybeCopyToProject = useCallback(async (filePath) => {
    if (!copyImportedFilesEnabled) return filePath;
    const ws = workspaceDirRef.current || readSetting(KEYS.WORKSPACE_DIR, { defaultValue: '' });
    if (isAlreadyManagedFile(filePath, ws, savePathRef.current)) return filePath;
    try {
      const targetWorkspace = ws || await getWorkspaceDir();
      if (!workspaceDir) setWorkspaceDirState(targetWorkspace);
      return await copyMediaToWorkspace(filePath, targetWorkspace, FICHIERS_IMPORTES, getProjectFilePrefix(store.project, savePathRef.current));
    } catch (e) {
      logger.error('media-transfer:copy-to-project-error', e);
      setSaveToast?.('error');
      setTimeout(() => setSaveToast?.(null), 3000);
      return filePath;
    }
  }, [copyImportedFilesEnabled, savePathRef, setSaveToast, setWorkspaceDirState, store, workspaceDir, workspaceDirRef]);

  const copyGeneratedMediaToProject = useCallback(async (filePath) => {
    const ws = workspaceDirRef.current || readSetting(KEYS.WORKSPACE_DIR, { defaultValue: '' });
    if (isAlreadyManagedFile(filePath, ws, savePathRef.current)) return filePath;
    try {
      const targetWorkspace = ws || await getWorkspaceDir();
      if (!workspaceDir) setWorkspaceDirState(targetWorkspace);
      return await copyMediaToWorkspace(filePath, targetWorkspace, FICHIERS_IMPORTES, getProjectFilePrefix(store.project, savePathRef.current));
    } catch (e) {
      logger.error('media-transfer:copy-generated-to-project-error', e);
      setSaveToast?.('error');
      setTimeout(() => setSaveToast?.(null), 3000);
      return filePath;
    }
  }, [savePathRef, setSaveToast, setWorkspaceDirState, store, workspaceDir, workspaceDirRef]);

  const dropOnNode = useCallback(async ({ nodeId, nodeType, path, paths, kind, clipboardMode }) => {
    if (kind !== 'audio' && kind !== 'image') return;
    const sourcePaths = (Array.isArray(paths) && paths.length > 0 ? paths : [path]).filter(Boolean);
    if (sourcePaths.length === 0) return;
    logger.info('media-transfer:drop', {
      nodeId,
      nodeType,
      kind,
      count: sourcePaths.length,
      clipboardMode: clipboardMode || 'copy',
    });
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
      // Remplacement de l'audio principal : on garde l'ancien fichier visible
      // dans le gestionnaire de médias (« Non utilisés ») au lieu de le rendre
      // orphelin invisible sur le disque.
      const previousAudio = findEntryById(store.project, nodeId)?.audio;
      store.updateItem(nodeId, { audio: finalPaths[0] });
      if (previousAudio && pathKey(previousAudio) !== pathKey(finalPaths[0])) {
        addPathsToMediaLibrary?.([previousAudio]);
      }
    }
  }, [addPathsToMediaLibrary, maybeCopyToProject, store]);

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

    const sample = candidates.slice(0, 5).map((candidate) => `• ${candidate.filename}`).join('\n');
    const suffix = candidates.length > 5
      ? `\n• …et ${formatFrenchCount(candidates.length - 5, 'autre', 'autres')}`
      : '';
    const confirmed = skipPrompt || (await ask(
        `${formatFrenchCount(
          candidates.length,
          'fichier déjà lié au projet est',
          'fichiers déjà liés au projet sont',
        )} encore hors de l’emplacement de travail.\n\n${sample}${suffix}\n\nLes copier dans fichiers-importes/ et mettre à jour le projet ?`,
        {
          title: 'Transférer les fichiers existants ?',
          kind: 'warning',
          okLabel: 'Transférer',
          cancelLabel: 'Plus tard',
        }
      ));

    if (!confirmed) {
      dismissedTransferPromptRef.current = signature;
      return { project, changed: false, copies: [] };
    }

    const transferResult = await transferProjectFilesToProject(
      project,
      savePath,
      async (sourcePath) => {
        const targetWorkspace = targetWorkspaceDir || workspaceDir || await getWorkspaceDir();
        if (!targetWorkspaceDir && !workspaceDir) setWorkspaceDirState(targetWorkspace);
        return copyMediaToWorkspace(sourcePath, targetWorkspace, FICHIERS_IMPORTES, getProjectFilePrefix(store.project, savePathRef.current));
      },
      pathAudit,
    );

    dismissedTransferPromptRef.current = null;

    if (transferResult.errors.length > 0) {
      const details = transferResult.errors
        .slice(0, 5)
        .map((error) => `• ${error.label}\n  ${error.error}`)
        .join('\n');
      showErrorDialog({
        title: 'Transfert incomplet',
        message: `Certains fichiers n'ont pas pu être transférés :\n\n${details}`,
      });
    }

    return {
      project: transferResult.project,
      changed: transferResult.copiedCount > 0,
      copies: transferResult.copies,
      errors: transferResult.errors,
    };
  }, [
    copyImportedFilesEnabled,
    dismissedTransferPromptRef,
    pathAudit,
    savePathRef,
    setWorkspaceDirState,
    showErrorDialog,
    store,
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
    dropOnNode,
    notifyCutPaste,
    extractAudioEmbeddedImage,
    maybeOfferTransferIntoProject,
    handleCopyImportedFilesChange,
  };
}
