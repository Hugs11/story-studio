import { translateImport as t } from '../i18n/importPresentation.js';
import { useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { classifyOsDroppedFiles } from '../store/projectHelpers';
import { logger } from '../utils/logger';
import { releaseTauriListener } from '../utils/tauriListener';
import { isTauriRuntime } from '../utils/tauriRuntime';
import { importFilesToMediaLibrary } from './mediaLibraryImport';
import { readPathKinds } from '../utils/packFolder';

export function useOsFileDrop({
  dispatchFiles,
  captureImport = null,
  maybeCopyToProject,
  copyGeneratedMediaToProject,
  extractAudioEmbeddedImage,
  addPathsToMediaLibrary,
  setImporting,
  setActiveDropZone,
  getImportDisplayName,
  showErrorDialog = null,
}) {
  const osDropScaleFactorRef = useRef(typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1);
  const osFileDropHandlerRef = useRef(null);
  const activeDropZoneRef = useRef(null);

  function setDropZone(zone) {
    const normalizedZone = zone || null;
    if (activeDropZoneRef.current === normalizedZone) return;
    activeDropZoneRef.current = normalizedZone;
    logger.info('os-drop:zone', { zone: normalizedZone });
    setActiveDropZone(normalizedZone);
  }

  osFileDropHandlerRef.current = async ({ type, paths, position }) => {
    const cssPosition = position
      ? {
          x: position.x / (osDropScaleFactorRef.current || 1),
          y: position.y / (osDropScaleFactorRef.current || 1),
        }
      : null;
    if (type === 'over' && position) {
      const el = document.elementFromPoint(cssPosition.x, cssPosition.y);
      const zone = el?.closest('[data-os-drop-zone]')?.dataset?.osDropZone ?? null;
      setDropZone(zone);
      return;
    }
    if (type === 'cancel' || type === 'leave') {
      setDropZone(null);
      return;
    }
    if (type === 'drop') {
      setDropZone(null);
      if (!paths?.length || !cssPosition) return;
      const el = document.elementFromPoint(cssPosition.x, cssPosition.y);
      const zone = el?.closest('[data-os-drop-zone]')?.dataset?.osDropZone ?? null;
      if (!zone) return;
      // Le type réel vient du moteur : un dossier nommé `x.mp3` n'est pas de l'audio.
      const kinds = await readPathKinds(paths);
      const { audio, images, archives, folders } = classifyOsDroppedFiles(paths, kinds);
      if (zone === 'treepanel') {
        // L'ordre du dépôt est celui de l'utilisateur, dossiers compris.
        const wanted = new Set([...audio, ...archives, ...folders]);
        const relevant = paths.filter((path) => wanted.has(path));
        if (relevant.length === 0) return;
        setImporting({ name: getImportDisplayName(relevant[0]), index: 0, total: relevant.length, get phase() { return t('import:media.preparation.progress'); } });
        try {
          await dispatchFiles(null, relevant, null, { folders });
        } finally {
          setImporting(null);
        }
      } else if (zone === 'mediaexplorer') {
        if (folders.length > 0) {
          showErrorDialog?.({
            get title() { return t('import:folder.import.title'); },
            get message() { return t('import:folder.drop.mediaLibrary'); },
            variant: 'info',
          });
        }
        const relevant = [...audio, ...images, ...archives];
        if (relevant.length === 0) return;
        const request = captureImport?.();
        const total = relevant.length;
        setImporting({ name: getImportDisplayName(relevant[0]), index: 0, total, get phase() { return t('import:media.preparation.progress'); } });
        try {
          const nextPaths = await importFilesToMediaLibrary({
            files: relevant,
            maybeCopyToProject: (path) => maybeCopyToProject(path, request?.copies),
            copyGeneratedMediaToProject: copyGeneratedMediaToProject ? (path) => copyGeneratedMediaToProject(path, request?.copies) : null,
            extractAudioEmbeddedImage,
            setImporting,
            getImportDisplayName,
          });
          if (!request || request.isCurrent()) addPathsToMediaLibrary(nextPaths);
        } finally {
          request?.release();
          setImporting(null);
        }
      }
    }
  };

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    let unlisten;
    let cancelled = false;
    const win = getCurrentWindow();
    // Un écouteur resté branché traiterait chaque dépôt une fois de plus.
    const releaseListener = (fn) => releaseTauriListener(fn, {
      onError: (error) => logger.warn('os-drop:unlisten-error', error),
    });
    win.scaleFactor()
      .then((factor) => {
        if (!cancelled && Number.isFinite(factor) && factor > 0) {
          osDropScaleFactorRef.current = factor;
        }
      })
      .catch(() => {});
    win.onDragDropEvent((event) => osFileDropHandlerRef.current(event.payload))
      .then((fn) => {
        if (cancelled) releaseListener(fn);
        else unlisten = fn;
      })
      .catch((error) => logger.error('os-drop:listen-error', error));
    return () => {
      cancelled = true;
      releaseListener(unlisten);
      setDropZone(null);
    };
  }, []);
}
