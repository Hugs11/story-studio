import { useState, useEffect } from 'react';
import { logger } from '../utils/logger';
import { MIME } from '../utils/mimeTypes';
import { FILE_CHANGED_EVENT, FILE_REFRESH_THROTTLE_MS, readPathSnapshot } from '../store/fileMetadataCache';
import { acquireLocalFileUrl } from '../store/localFileUrlCache';

function normalizeFsPath(path) {
  if (typeof path !== 'string') return '';
  const trimmed = path.trim();
  if (trimmed.startsWith('\\\\?\\UNC\\')) return `\\\\${trimmed.slice(8)}`;
  return trimmed.startsWith('\\\\?\\') ? trimmed.slice(4) : trimmed;
}

function versionOf(snapshot) {
  return `${snapshot.size ?? ''}:${snapshot.mtimeMs ?? ''}`;
}

export function useLocalFile(path) {
  const [url, setUrl] = useState(null);

  useEffect(() => {
    if (!path) {
      setUrl(null);
      return undefined;
    }

    let cancelled = false;
    let activeRelease = null;
    let forceNonce = 0;
    const readablePath = normalizeFsPath(path);
    const ext = readablePath.split('.').pop().toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';

    function releaseActive() {
      if (activeRelease) {
        activeRelease();
        activeRelease = null;
      }
    }

    async function loadCurrentPath({ allowThrottle = false, force = false } = {}) {
      try {
        const snapshot = await readPathSnapshot(readablePath, {
          maxAgeMs: allowThrottle ? FILE_REFRESH_THROTTLE_MS : 0,
          force,
        });
        if (cancelled) return;
        if (!snapshot.exists) {
          releaseActive();
          setUrl(null);
          return;
        }

        // Sur une relecture forcee (contenu change sans changer de chemin, ou
        // `stat` indisponible), on casse le cache via un nonce pour garantir
        // une vraie relecture plutot que de reutiliser une version stale.
        const version = force ? `${versionOf(snapshot)}:f${++forceNonce}` : versionOf(snapshot);
        const { promise, release } = acquireLocalFileUrl({ path: readablePath, mime, version });

        // On garde l'URL precedente vivante jusqu'a ce que la nouvelle soit prete
        // (evite un flash), puis on relache l'ancienne reference.
        const previousRelease = activeRelease;
        activeRelease = release;
        if (previousRelease) previousRelease();

        const nextUrl = await promise;
        if (cancelled) return;
        setUrl(nextUrl);
      } catch (err) {
        logger.error('local-file:read-error', path, err);
        if (cancelled) return;
        releaseActive();
        setUrl(null);
      }
    }

    function handleFocus() {
      void loadCurrentPath({ allowThrottle: true });
    }

    function handleFileChanged(event) {
      if (normalizeFsPath(event?.detail?.path ?? '') !== readablePath) return;
      // Le contenu a change sans changer de chemin : on relit en forcant.
      void loadCurrentPath({ force: true });
    }

    // On force une vraie lecture au montage/changement de chemin pour eviter
    // de reutiliser un cache stale juste apres une extraction ou un remplacement.
    void loadCurrentPath({ allowThrottle: false });
    window.addEventListener('focus', handleFocus);
    window.addEventListener(FILE_CHANGED_EVENT, handleFileChanged);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener(FILE_CHANGED_EVENT, handleFileChanged);
      releaseActive();
    };
  }, [path]);

  return url;
}
