import { installProjectAccess, releaseProjectAccess } from '../store/projectSessionAccess.js';
import { translateImport as t } from '../i18n/importPresentation.js';
import { presentUserMessage } from '../i18n/userMessage.js';
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
  // Donne une chance de prendre en charge un projet relu avant qu'il remplace
  // le travail courant (copie graphe d'un projet par menus ouvert depuis le
  // graphe). Rend `true` quand il l'a pris en charge.
  routeLoadedProject = null,
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
    await installProjectAccess(result.accessToken, result.data);
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
        if (!entry.name?.trim() && data.title?.trim()) nextFields.name = sanitizeImportedName(data.title.trim(), t('import:names.zip.fallback'));
        if (Object.keys(nextFields).length > 0) store.updateItem(entry.id, nextFields);
      } catch (e) {
        const scope = ancestors.map((parent) => parent.name).join(' / ') || 'racine';
        logger.warn('load:zip-metadata-error', { scope, zipPath: entry.zipPath, error: presentUserMessage(e).message });
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
    let claimed = null;
    try {
      const result = await loadProject();
      claimed = result?.accessToken;
      if (result && await routeLoadedProject?.(result)) { await releaseProjectAccess(result.accessToken); return; }
      if (result) {
        await onBeforeProjectReplaced?.();
        await applyLoadedProject(result);
      }
    } catch (error) {
      await releaseProjectAccess(claimed).catch(() => {});
      logger.error(`load:error error=${presentUserMessage(error).message}`);
      showErrorDialog({
        get title() { return error?.code === 'VALIDATION_MENU_DEPTH_LIMIT' ? t('import:project.depth.title') : t('import:project.open.title'); },
        message: error,
      });
    }
  }, [
    applyLoadedProject,
    confirmSaveBeforeLeaveCurrent,
    handleSaveProject,
    onBeforeProjectReplaced,
    routeLoadedProject,
    showErrorDialog,
  ]);

  const openProjectFromPath = useCallback(async (path, { forgetOnFailure = false } = {}) => {
    const canContinue = await confirmSaveBeforeLeaveCurrent(handleSaveProject);
    if (!canContinue) return false;
    let claimed = null;
    try {
      const result = await loadProjectFromPath(path, { editorAccess: true });
      claimed = result.accessToken;
      await onBeforeProjectReplaced?.();
      await applyLoadedProject(result);
      return true;
    } catch (e) {
      await releaseProjectAccess(claimed).catch(() => {});
      logger.error(`load-recent:error path='${path}' error=${presentUserMessage(e).message}`);
      if (forgetOnFailure) setRecentProjects(forgetRecentProject(path));
      showErrorDialog({
        get title() { return t('import:project.recent.title'); },
        message: { userMessage: e, prefix: { key: 'import:project.recent.prefix' }, suffix: `` },
      });
      return false;
    }
  }, [
    applyLoadedProject,
    confirmSaveBeforeLeaveCurrent,
    handleSaveProject,
    onBeforeProjectReplaced,
    setRecentProjects,
    showErrorDialog,
  ]);

  const handleLoadRecent = useCallback(path => openProjectFromPath(path, { forgetOnFailure: true }), [openProjectFromPath]);

  return { applyLoadedProject, handleLoad, handleLoadRecent, openProjectFromPath };
}
