import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { pathKey } from '../utils/fileUtils';
import {
  collectMediaLibrary,
  executeMediaDeletion,
  mergeMediaLibraryPaths,
  reconcileMediaLibraryPaths,
} from '../store/mediaLibrary';

export function useMediaLibraryPaths({ store, sdStore, xttsStore, workspaceDirRef, mediaCatalogChangedRef = null }) {
  const [mediaLibraryPaths, setMediaLibraryPaths] = useState([]);
  const mediaLibraryPathsRef = useRef([]);
  mediaLibraryPathsRef.current = mediaLibraryPaths;

  const addPathsToMediaLibrary = useCallback((paths) => {
    const previous = mediaLibraryPathsRef.current;
    const merged = mergeMediaLibraryPaths(previous, paths);
    if (merged.length === previous.length) return;
    mediaLibraryPathsRef.current = merged;
    setMediaLibraryPaths(merged);
    mediaCatalogChangedRef?.current?.();
  }, [mediaCatalogChangedRef]);

  // Invariant du catalogue : tout média vu dans le projet reste connu après la
  // disparition de sa dernière référence. Les suppressions structurelles n'ont
  // donc aucun traitement média particulier à dupliquer dans chaque éditeur.
  useEffect(() => {
    const previous = mediaLibraryPathsRef.current;
    const reconciled = reconcileMediaLibraryPaths(store.project, previous);
    if (reconciled.length === previous.length) return;
    mediaLibraryPathsRef.current = reconciled;
    setMediaLibraryPaths(reconciled);
  }, [store.project]);

  const handleMediaCreated = useCallback((path) => {
    if (!path) return;
    addPathsToMediaLibrary([path]);
  }, [addPathsToMediaLibrary]);

  const handleDeleteMedia = useCallback(async (item, { deleteFromDisk = false } = {}) => {
    if (!item?.path) return { removed: false, diskDeleted: false, diskError: null };
    const key = pathKey(item.path);
    const liveLibrary = collectMediaLibrary({
      project: store.project,
      sdJobs: sdStore.jobs,
      xttsJobs: xttsStore.jobs,
      extraPaths: mediaLibraryPathsRef.current,
    });
    const liveItem = liveLibrary.find((media) => pathKey(media.path) === key) ?? item;
    const preservePaths = liveLibrary
      .map((media) => media.path)
      .filter((path) => pathKey(path) !== key);

    return executeMediaDeletion({
      item: liveItem,
      deleteFromDisk,
      deleteDisk: () => invoke('delete_workspace_media_file', {
        path: item.path,
        workspaceDir: workspaceDirRef.current || '',
        preservePaths,
      }),
      commitRemoval: () => {
        const nextPaths = mediaLibraryPathsRef.current.filter((path) => pathKey(path) !== key);
        mediaLibraryPathsRef.current = nextPaths;
        setMediaLibraryPaths(nextPaths);
        for (const job of xttsStore.jobs) {
          if (pathKey(job?.resultPath) === key) xttsStore.removeJob(job.id);
        }
        for (const job of sdStore.jobs) {
          if (!(job?.resultPaths ?? []).some((path) => pathKey(path) === key)) continue;
          const nextPaths = job.resultPaths.filter((path) => pathKey(path) !== key);
          if (nextPaths.length === 0) sdStore.removeJob(job.id);
          else sdStore.updateJob(job.id, { resultPaths: nextPaths });
        }
        store.deleteMediaTagsForPath(item.path);
      },
    });
  }, [sdStore, store, workspaceDirRef, xttsStore]);

  return {
    mediaLibraryPaths,
    mediaLibraryPathsRef,
    setMediaLibraryPaths,
    addPathsToMediaLibrary,
    handleMediaCreated,
    handleDeleteMedia,
  };
}
