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
import { logger } from '../utils/logger';

async function askSaveBeforeLeave(project, savedSnapshot, onSave, showChoiceDialog, isProjectDirty) {
  const unchanged = savedSnapshot === null
    ? !isProjectDirty(project)
    : JSON.stringify(project) === savedSnapshot;
  if (unchanged) return true;
  const choice = await showChoiceDialog({
    title: 'Projet non sauvegardé',
    message: 'Voulez-vous sauvegarder le projet avant de continuer ?',
    variant: 'warning',
    cancelValue: 'cancel',
    actions: [
      { value: 'cancel', label: 'Annuler', autoFocus: true },
      { value: 'discard', label: 'Ne pas sauvegarder', kind: 'danger-outline' },
      { value: 'save', label: 'Sauvegarder', kind: 'primary' },
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

export function useProjectLoading({
  store,
  sdStore,
  xttsStore,
  setMediaLibraryPaths,
  setRecentProjects,
  savedSnapshotRef,
  autoSavePathRef,
  setAutoSavedPath,
  handleSaveProject,
  showErrorDialog,
  isProjectDirty,
  showChoiceDialog,
}) {
  const applyLoadedProject = useCallback(async (result) => {
    const entries = result?.data?.rootEntries?.length ?? 0;
    logger.info(`load:done path='${result.path}' projectType=${result.data?.projectType || 'none'} schemaVersion=${result.data?.schemaVersion ?? '?'} entries=${entries}`);
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
        logger.warn('load:zip-metadata-error', { scope, zipPath: entry.zipPath, error: String(e) });
      }
    }
  }, [
    autoSavePathRef,
    savedSnapshotRef,
    sdStore,
    setAutoSavedPath,
    setMediaLibraryPaths,
    setRecentProjects,
    store,
    xttsStore,
  ]);

  const handleLoad = useCallback(async () => {
    const canContinue = await askSaveBeforeLeave(
      store.project,
      savedSnapshotRef.current,
      handleSaveProject,
      showChoiceDialog,
      isProjectDirty,
    );
    if (!canContinue) return;
    const result = await loadProject();
    if (result) {
      await applyLoadedProject(result);
    }
  }, [applyLoadedProject, handleSaveProject, isProjectDirty, savedSnapshotRef, showChoiceDialog, store.project]);

  const handleLoadRecent = useCallback(async (path) => {
    const canContinue = await askSaveBeforeLeave(
      store.project,
      savedSnapshotRef.current,
      handleSaveProject,
      showChoiceDialog,
      isProjectDirty,
    );
    if (!canContinue) return;
    try {
      const result = await loadProjectFromPath(path);
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
    handleSaveProject,
    isProjectDirty,
    savedSnapshotRef,
    setRecentProjects,
    showErrorDialog,
    showChoiceDialog,
    store.project,
  ]);

  return { applyLoadedProject, handleLoad, handleLoadRecent };
}
