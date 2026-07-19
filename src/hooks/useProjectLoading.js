import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  forgetRecentProject,
  loadProject,
  loadProjectFromPath,
  rememberRecentProject,
} from '../store/projectIO';
import { sanitizeImportedName } from '../store/projectStore';
import { visitProjectEntries } from '../store/projectModel';
import { createWorkSnapshot } from '../store/projectHelpers';
import { logger } from '../utils/logger';

export function useProjectLoading({
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
  handleSaveProject,
  showErrorDialog,
  onProjectLoaded = null,
  onBeforeProjectReplaced = null,
}) {
  const applyLoadedProject = useCallback(async (result) => {
    const entries = result?.data?.rootEntries?.length ?? 0;
    logger.info(`load:done path='${result.path}' projectType=${result.data?.projectType || 'none'} schemaVersion=${result.data?.schemaVersion ?? '?'} entries=${entries}`);
    store.loadProject(result.data);
    store.setMediaTags(result.mediaTags ?? {});
    store.setSavePath(result.path);
    setMediaLibraryPaths(result.mediaLibraryPaths ?? []);
    setRecentProjects(rememberRecentProject(result.data, result.path));
    savedSnapshotRef.current = createWorkSnapshot(
      result.data,
      result.mediaLibraryPaths ?? [],
      result.mediaTags ?? {},
    );
    autoSavePathRef.current = null;
    autoSaveSnapshotRef.current = null;
    setAutoSavedPath(null);
    await onProjectLoaded?.(result);
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
        logger.warn('load:zip-metadata-error', { scope, zipPath: entry.zipPath, error: String(e) });
      }
    }
  }, [
    autoSavePathRef,
    autoSaveSnapshotRef,
    savedSnapshotRef,
    sdStore,
    setAutoSavedPath,
    setMediaLibraryPaths,
    setRecentProjects,
    store,
    onProjectLoaded,
    xttsStore,
  ]);

  const handleLoad = useCallback(async () => {
    const canContinue = await confirmSaveBeforeLeaveCurrent(handleSaveProject);
    if (!canContinue) return;
    const result = await loadProject();
    if (result) {
      await onBeforeProjectReplaced?.();
      await applyLoadedProject(result);
    }
  }, [applyLoadedProject, confirmSaveBeforeLeaveCurrent, handleSaveProject, onBeforeProjectReplaced]);

  const handleLoadRecent = useCallback(async (path) => {
    const canContinue = await confirmSaveBeforeLeaveCurrent(handleSaveProject);
    if (!canContinue) return;
    try {
      const result = await loadProjectFromPath(path);
      await onBeforeProjectReplaced?.();
      await applyLoadedProject(result);
    } catch (e) {
      logger.error(`load-recent:error path='${path}' error=${e}`);
      setRecentProjects(forgetRecentProject(path));
      showErrorDialog({
        title: 'Projet récent',
        message: `Impossible d'ouvrir ce projet récent :\n${e}`,
      });
    }
  }, [
    applyLoadedProject,
    confirmSaveBeforeLeaveCurrent,
    handleSaveProject,
    onBeforeProjectReplaced,
    setRecentProjects,
    showErrorDialog,
  ]);

  return { applyLoadedProject, handleLoad, handleLoadRecent };
}
