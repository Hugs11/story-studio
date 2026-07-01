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
    title: 'Projet non enregistré',
    message: "Ton travail n'est pas enregistré et sera définitivement perdu.",
    variant: 'warning',
    cancelValue: 'cancel',
    actions: [
      { value: 'cancel', label: 'Annuler', autoFocus: true },
      { value: 'discard', label: 'Quitter sans enregistrer', kind: 'danger-outline' },
      { value: 'save', label: 'Enregistrer comme projet', kind: 'primary' },
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
    savedSnapshotRef.current = JSON.stringify(result.data);
    autoSavePathRef.current = null;
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
      await onBeforeProjectReplaced?.();
      await applyLoadedProject(result);
    }
  }, [applyLoadedProject, handleSaveProject, isProjectDirty, onBeforeProjectReplaced, savedSnapshotRef, showChoiceDialog, store.project]);

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
    handleSaveProject,
    isProjectDirty,
    onBeforeProjectReplaced,
    savedSnapshotRef,
    setRecentProjects,
    showErrorDialog,
    showChoiceDialog,
    store.project,
  ]);

  return { applyLoadedProject, handleLoad, handleLoadRecent };
}
