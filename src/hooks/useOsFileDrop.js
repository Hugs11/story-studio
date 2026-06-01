import { useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { classifyOsDroppedFiles } from '../store/projectHelpers';
import { logger } from '../utils/logger';
import { isTauriRuntime } from '../utils/tauriRuntime';
import { importFilesToMediaLibrary } from './mediaLibraryImport';

export function useOsFileDrop({
  dispatchFiles,
  maybeCopyToProject,
  copyGeneratedMediaToProject,
  extractAudioEmbeddedImage,
  addPathsToMediaLibrary,
  setImporting,
  setActiveDropZone,
  getImportDisplayName,
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
      const { audio, images, archives } = classifyOsDroppedFiles(paths);
      if (zone === 'treepanel') {
        const relevant = [...audio, ...archives];
        if (relevant.length === 0) return;
        setImporting({ name: getImportDisplayName(relevant[0]), index: 0, total: relevant.length, phase: "Préparation de l'import..." });
        try {
          await dispatchFiles(null, relevant);
        } finally {
          setImporting(null);
        }
      } else if (zone === 'mediaexplorer') {
        const relevant = [...audio, ...images, ...archives];
        if (relevant.length === 0) return;
        const total = relevant.length;
        setImporting({ name: getImportDisplayName(relevant[0]), index: 0, total, phase: "Préparation de l'import..." });
        try {
          const nextPaths = await importFilesToMediaLibrary({
            files: relevant,
            maybeCopyToProject,
            copyGeneratedMediaToProject,
            extractAudioEmbeddedImage,
            setImporting,
            getImportDisplayName,
          });
          addPathsToMediaLibrary(nextPaths);
        } finally {
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
    win.scaleFactor()
      .then((factor) => {
        if (!cancelled && Number.isFinite(factor) && factor > 0) {
          osDropScaleFactorRef.current = factor;
        }
      })
      .catch(() => {});
    win.onDragDropEvent((event) => osFileDropHandlerRef.current(event.payload))
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((error) => logger.error('os-drop:listen-error', error));
    return () => {
      cancelled = true;
      unlisten?.();
      setDropZone(null);
    };
  }, []);
}
