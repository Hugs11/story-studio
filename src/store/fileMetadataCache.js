import { exists, stat } from '@tauri-apps/plugin-fs';
import { pathKey, stripWindowsLongPathPrefix } from '../utils/fileUtils';

export const FILE_REFRESH_THROTTLE_MS = 1500;
const PATH_QUERY_TIMEOUT_MS = 4000;

const pathSnapshotCache = new Map();
const inflightPathSnapshots = new Map();
let statPermissionAvailable = true;

function readablePath(path) {
  if (typeof path !== 'string') return '';
  return stripWindowsLongPathPrefix(path.trim());
}

function cacheKey(path) {
  return pathKey(readablePath(path));
}

function normalizeTimeMs(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? time : null;
}

function buildSnapshot(path, info, exists) {
  return {
    path,
    exists,
    size: exists ? (info?.size ?? null) : null,
    mtimeMs: exists ? normalizeTimeMs(info?.mtime) : null,
    checkedAt: Date.now(),
  };
}

function isFresh(snapshot, maxAgeMs) {
  return !!snapshot
    && maxAgeMs > 0
    && (Date.now() - snapshot.checkedAt) < maxAgeMs;
}

async function queryPathSnapshot(path) {
  try {
    let existsTimeoutId = null;
    const pathExists = await Promise.race([
      exists(path),
      new Promise((_, reject) => {
        existsTimeoutId = setTimeout(() => reject(new Error('fs.exists timeout')), PATH_QUERY_TIMEOUT_MS);
      }),
    ]).finally(() => {
      if (existsTimeoutId) clearTimeout(existsTimeoutId);
    });
    if (!pathExists) {
      return buildSnapshot(path, null, false);
    }
    if (!statPermissionAvailable) {
      return buildSnapshot(path, null, true);
    }
    try {
      let statTimeoutId = null;
      const info = await Promise.race([
        stat(path),
        new Promise((_, reject) => {
          statTimeoutId = setTimeout(() => reject(new Error('fs.stat timeout')), PATH_QUERY_TIMEOUT_MS);
        }),
      ]).finally(() => {
        if (statTimeoutId) clearTimeout(statTimeoutId);
      });
      return buildSnapshot(path, info, true);
    } catch (error) {
      if (String(error).includes('fs.stat not allowed')) {
        statPermissionAvailable = false;
      }
      return buildSnapshot(path, null, true);
    }
  } catch {
    return buildSnapshot(path, null, false);
  }
}

function getCachedPathSnapshot(path) {
  const key = cacheKey(path);
  if (!key) return null;
  return pathSnapshotCache.get(key) ?? null;
}

export function hasFreshPathSnapshot(path, maxAgeMs = FILE_REFRESH_THROTTLE_MS) {
  return isFresh(getCachedPathSnapshot(path), maxAgeMs);
}

export const FILE_CHANGED_EVENT = 'local-file-changed';

// Signale qu'un fichier a changé sur disque sans changer de chemin. Invalide le
// snapshot et notifie les `useLocalFile` montés sur ce chemin pour qu'ils
// relisent le contenu, sans dépendre de la détection mtime/taille (qui peut être
// indisponible si `stat` n'est pas permis).
export function notifyFileChanged(path) {
  const normalizedPath = readablePath(path);
  const key = cacheKey(normalizedPath);
  if (!key) return;
  pathSnapshotCache.delete(key);
  window.dispatchEvent(new CustomEvent(FILE_CHANGED_EVENT, { detail: { path: normalizedPath } }));
}

export async function readPathSnapshot(path, { maxAgeMs = 0, force = false } = {}) {
  const normalizedPath = readablePath(path);
  if (!normalizedPath) return buildSnapshot('', null, false);
  const key = cacheKey(normalizedPath);

  const cachedSnapshot = pathSnapshotCache.get(key);
  if (!force && isFresh(cachedSnapshot, maxAgeMs)) {
    return cachedSnapshot;
  }

  const inflight = inflightPathSnapshots.get(key);
  if (inflight) return inflight;

  const promise = queryPathSnapshot(normalizedPath)
    .then((snapshot) => {
      pathSnapshotCache.set(key, snapshot);
      inflightPathSnapshots.delete(key);
      return snapshot;
    })
    .catch((error) => {
      inflightPathSnapshots.delete(key);
      throw error;
    });

  inflightPathSnapshots.set(key, promise);
  return promise;
}
