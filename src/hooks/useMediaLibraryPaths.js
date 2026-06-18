import { useCallback, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { pathKey } from '../utils/fileUtils';
import { collectMediaLibrary } from '../store/mediaLibrary';

export function useMediaLibraryPaths({ store, sdStore, xttsStore, workspaceDirRef }) {
  const [mediaLibraryPaths, setMediaLibraryPaths] = useState([]);
  const mediaLibraryPathsRef = useRef([]);
  mediaLibraryPathsRef.current = mediaLibraryPaths;

  const addPathsToMediaLibrary = useCallback((paths) => {
    setMediaLibraryPaths((previous) => {
      const seen = new Set(previous.map((path) => pathKey(path)));
      const merged = [...previous];
      for (const path of paths) {
        const key = pathKey(path);
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(path);
        }
      }
      return merged;
    });
  }, []);

  const handleMediaCreated = useCallback((path) => {
    if (!path) return;
    setMediaLibraryPaths((previous) => {
      const key = pathKey(path);
      if (previous.some((existing) => pathKey(existing) === key)) return previous;
      return [...previous, path];
    });
  }, []);

  const handleDeleteMedia = useCallback(async (item, { deleteFromDisk = false } = {}) => {
    if (!item?.path) return { diskDeleted: false, diskError: null };
    if (item.inProject) {
      store.removeMediaReferences(item.path);
    }

    const key = pathKey(item.path);
    setMediaLibraryPaths((previous) => previous.filter((path) => pathKey(path) !== key));
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
    if (!deleteFromDisk) {
      return { diskDeleted: false, diskError: null };
    }
    const workspace = workspaceDirRef.current || '';
    const preservePaths = collectMediaLibrary({
      project: store.project,
      sdJobs: sdStore.jobs,
      xttsJobs: xttsStore.jobs,
      extraPaths: mediaLibraryPathsRef.current,
    })
      .map((media) => media.path)
      .filter((path) => pathKey(path) !== key);
    try {
      await invoke('delete_workspace_media_file', { path: item.path, workspaceDir: workspace, preservePaths });
      return { diskDeleted: true, diskError: null };
    } catch (error) {
      const message = typeof error === 'string' ? error : (error?.message || String(error));
      return { diskDeleted: false, diskError: message };
    }
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
