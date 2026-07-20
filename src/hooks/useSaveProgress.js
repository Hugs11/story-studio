import { useCallback, useRef, useState } from 'react';
import {
  ensureWorkspaceDir,
  rememberRecentProject,
  saveProject,
  saveProjectAs,
} from '../store/projectIO';
import {
  createWorkSnapshot,
  isSaveInputStillCurrent,
  shouldAbortEphemeralPromotion,
} from '../store/projectHelpers';
import { logger } from '../utils/logger';

export function useSaveProgress({
  store,
  workspaceDirRef,
  mediaLibraryPathsRef,
  setMediaLibraryPaths,
  autoSaveEnabled,
  autoSaveBackupLimit,
  savedSnapshotRef,
  autoSaveSnapshotRef,
  sessionModeRef = null,
  isSavingRef,
  setSaveToast,
  setRecentProjects,
  maybeOfferTransferIntoProject,
  triageSessionMedia = null,
  onProjectSaved = null,
}) {
  const [saveProgress, setSaveProgress] = useState(null); // null | { lines: string[], complete: boolean }
  const [saveAsProgress, setSaveAsProgress] = useState(null);
  const liveStoreRef = useRef(store);
  liveStoreRef.current = store;

  const persistProjectSnapshot = useCallback(async (project, savePath) => {
    const result = await saveProject(project, savePath, null, {
      mediaTags: store.mediaTags,
      mediaLibraryPaths: mediaLibraryPathsRef.current,
      workspaceDir: workspaceDirRef.current,
    });
    if (!result?.path) return null;
    store.syncProjectWithoutHistory(result.project);
    store.setSavePath(result.path);
    if (result.mediaLibraryPaths) {
      setMediaLibraryPaths(result.mediaLibraryPaths);
      mediaLibraryPathsRef.current = result.mediaLibraryPaths;
    }
    savedSnapshotRef.current = createWorkSnapshot(
      result.project,
      result.mediaLibraryPaths ?? mediaLibraryPathsRef.current,
      store.mediaTags,
    );
    autoSaveSnapshotRef.current = null;
    setSaveToast('ok');
    setTimeout(() => setSaveToast(null), 2000);
    return result.path;
  }, [autoSaveSnapshotRef, mediaLibraryPathsRef, savedSnapshotRef, setMediaLibraryPaths, setSaveToast, store, workspaceDirRef]);

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
    const projectToSave = projectOverride ?? liveStore.project;
    const mediaTagsToSave = mediaTagsOverride ?? liveStore.mediaTags;
    const mediaLibraryPathsToSave = mediaLibraryPathsOverride ?? mediaLibraryPathsRef.current;
    logger.info(`save:start kind=${silent ? 'auto' : 'manual'} hasPath=${!!liveStore.savePath} projectType=${projectToSave?.projectType || 'none'} entries=${projectToSave?.rootEntries?.length ?? 0}`);
    try {
      let result = await saveProject(projectToSave, liveStore.savePath, onProgress, {
        autosave: silent,
        backupLimit: autoSaveEnabled ? autoSaveBackupLimit : 0,
        mediaTags: mediaTagsToSave,
        mediaLibraryPaths: mediaLibraryPathsToSave,
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
          result = await saveProject(transferResult.project, result.path, onProgress, {
            mediaTags: mediaTagsToSave,
            mediaLibraryPaths: mediaLibraryPathsToSave,
            workspaceDir: workspaceDirRef.current,
          });
        }
        const currentStore = liveStoreRef.current;
        if (isSaveInputStillCurrent(projectToSave, currentStore.project)) {
          currentStore.syncProjectWithoutHistory(result.project);
        }
        currentStore.setSavePath(result.path);
        if (
          result.mediaLibraryPaths
          && isSaveInputStillCurrent(mediaLibraryPathsToSave, mediaLibraryPathsRef.current)
        ) {
          setMediaLibraryPaths(result.mediaLibraryPaths);
          mediaLibraryPathsRef.current = result.mediaLibraryPaths;
        }
        setRecentProjects(rememberRecentProject(result.project, result.path));
        savedSnapshotRef.current = createWorkSnapshot(
          result.project,
          result.mediaLibraryPaths ?? mediaLibraryPathsToSave,
          mediaTagsToSave,
        );
        autoSaveSnapshotRef.current = null;
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
    autoSaveSnapshotRef,
    isSavingRef,
    maybeOfferTransferIntoProject,
    mediaLibraryPathsRef,
    savedSnapshotRef,
    setRecentProjects,
    setMediaLibraryPaths,
    setSaveToast,
    store,
    workspaceDirRef,
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
    try {
      const isEphemeralSession = sessionModeRef?.current === 'ephemeral';
      const targetWorkspaceDir = isEphemeralSession
        ? await ensureWorkspaceDir()
        : workspaceDirRef.current;
      let result = await saveProjectAs(store.project, store.savePath, onProgress, store.mediaTags, {
        workspaceDir: targetWorkspaceDir,
      }, mediaLibraryPathsRef.current);
      if (!result) {
        setSaveAsProgress(null);
        return null;
      }
      if (result?.path) {
        let finalMediaTags = store.mediaTags;
        let finalMediaLibraryPaths = result.mediaLibraryPaths ?? mediaLibraryPathsRef.current;
        const transferResult = await maybeOfferTransferIntoProject(result.project, result.path, {
          copyEnabled: true,
          skipPrompt: isEphemeralSession,
          targetWorkspaceDir,
        });
        const transferErrors = transferResult.errors ?? [];
        if (shouldAbortEphemeralPromotion({ isEphemeralSession, transferErrors })) {
          logger.warn(`save-as:abort-ephemeral-transfer-errors count=${transferErrors.length}`);
          setSaveAsProgress(null);
          setSaveToast('error');
          setTimeout(() => setSaveToast(null), 3000);
          return null;
        }
        // Tri des médias de session non utilisés : après le
        // transfert des médias référencés, avant le nettoyage de la session.
        // Le tri résout tous ses échecs de copie en interne (réessayer /
        // abandonner) : à son retour, plus aucun média conservé ne dépend du
        // dossier de session.
        let triageResult = { changed: false };
        if (isEphemeralSession && triageSessionMedia) {
          triageResult = await triageSessionMedia({
            project: transferResult.project,
            savePath: result.path,
            targetWorkspaceDir,
            transferCopies: transferResult.copies ?? [],
          });
        }
        finalMediaTags = triageResult.mediaTags ?? finalMediaTags;
        finalMediaLibraryPaths = triageResult.mediaLibraryPaths ?? finalMediaLibraryPaths;
        if (transferResult.changed || triageResult.changed) {
          result = await saveProject(transferResult.project, result.path, onProgress, {
            mediaTags: finalMediaTags,
            mediaLibraryPaths: finalMediaLibraryPaths,
            workspaceDir: targetWorkspaceDir,
          });
          finalMediaLibraryPaths = result.mediaLibraryPaths ?? finalMediaLibraryPaths;
        }
        store.syncProjectWithoutHistory(result.project);
        store.setSavePath(result.path);
        if (result.mediaLibraryPaths) {
          setMediaLibraryPaths(result.mediaLibraryPaths);
          mediaLibraryPathsRef.current = result.mediaLibraryPaths;
        }
        setRecentProjects(rememberRecentProject(result.project, result.path));
        savedSnapshotRef.current = createWorkSnapshot(
          result.project,
          finalMediaLibraryPaths,
          finalMediaTags,
        );
        autoSaveSnapshotRef.current = null;
        await onProjectSaved?.(result, {
          promote: true,
          workspaceDir: targetWorkspaceDir,
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
      setSaveAsProgress(null);
      setSaveToast('error');
      setTimeout(() => setSaveToast(null), 3000);
      return null;
    }
  }, [
    autoSaveSnapshotRef,
    mediaLibraryPathsRef,
    maybeOfferTransferIntoProject,
    onProjectSaved,
    savedSnapshotRef,
    setRecentProjects,
    setMediaLibraryPaths,
    setSaveToast,
    sessionModeRef,
    store,
    triageSessionMedia,
    workspaceDirRef,
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
