import { useState, useEffect, useRef } from 'react';
import { readFile } from '@tauri-apps/plugin-fs';
import { logger } from '../utils/logger';
import { FILE_REFRESH_THROTTLE_MS, didPathSnapshotChange, readPathSnapshot } from './fileMetadataCache';

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  bmp: 'image/bmp', gif: 'image/gif',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', webm: 'audio/webm',
  flac: 'audio/flac',
};

function revokeObjectUrlSoon(url) {
  if (!url) return;
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function normalizeFsPath(path) {
  if (typeof path !== 'string') return '';
  const trimmed = path.trim();
  if (trimmed.startsWith('\\\\?\\UNC\\')) return `\\\\${trimmed.slice(8)}`;
  return trimmed.startsWith('\\\\?\\') ? trimmed.slice(4) : trimmed;
}

export function useLocalFile(path) {
  const [url, setUrl] = useState(null);
  const urlRef = useRef(null);
  const snapshotRef = useRef(null);

  useEffect(() => {
    if (!path) {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
      snapshotRef.current = null;
      setUrl(null);
      return undefined;
    }

    let cancelled = false;
    const readablePath = normalizeFsPath(path);

    function clearCurrentUrl() {
      revokeObjectUrlSoon(urlRef.current);
      urlRef.current = null;
      setUrl(null);
    }

    async function loadCurrentPath({ allowThrottle = false } = {}) {
      const ext = readablePath.split('.').pop().toLowerCase();
      const mime = MIME[ext] || 'application/octet-stream';

      try {
        const nextSnapshot = await readPathSnapshot(readablePath, {
          maxAgeMs: allowThrottle ? FILE_REFRESH_THROTTLE_MS : 0,
        });
        if (cancelled) return;

        const previousSnapshot = snapshotRef.current;
        snapshotRef.current = nextSnapshot;
        if (!nextSnapshot.exists) {
          clearCurrentUrl();
          return;
        }

        const shouldReload = !urlRef.current || didPathSnapshotChange(previousSnapshot, nextSnapshot);
        if (!shouldReload) return;

        const data = await readFile(readablePath);
        if (cancelled) return;
        const objectUrl = URL.createObjectURL(new Blob([data], { type: mime }));
        revokeObjectUrlSoon(urlRef.current);
        urlRef.current = objectUrl;
        setUrl(objectUrl);
      } catch (err) {
        logger.error('[useLocalFile] readFile failed:', path, err);
        if (cancelled) return;
        clearCurrentUrl();
      }
    }

    function handleFocus() {
      void loadCurrentPath({ allowThrottle: true });
    }

    // On force une vraie lecture au montage/changement de chemin pour éviter
    // de réutiliser un cache stale juste après une extraction ou un remplacement.
    void loadCurrentPath({ allowThrottle: false });
    window.addEventListener('focus', handleFocus);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', handleFocus);
      revokeObjectUrlSoon(urlRef.current);
      urlRef.current = null;
      snapshotRef.current = null;
    };
  }, [path]);

  return url;
}
