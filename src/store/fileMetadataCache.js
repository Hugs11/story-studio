import { exists, stat } from '@tauri-apps/plugin-fs';
import { pathKey, stripWindowsLongPathPrefix } from '../utils/fileUtils.js';

export const FILE_REFRESH_THROTTLE_MS = 1500;
export const FILE_RETRY_DELAYS_MS = Object.freeze([1500, 3000, 6000]);
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
    current: true,
  };
}

function isFresh(snapshot, maxAgeMs) {
  return !!snapshot
    && maxAgeMs > 0
    && (Date.now() - snapshot.checkedAt) < maxAgeMs;
}

// Une réponse native booléenne est un constat ; un délai ou un rejet ne l'est
// pas. Cette lecture directe sert aussi aux portes qui doivent éviter le cache.
export async function readPathExistence(path, { timeoutMs = PATH_QUERY_TIMEOUT_MS } = {}) {
  let timeoutId;
  try {
    const result = await Promise.race([
      exists(readablePath(path)),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    return typeof result === 'boolean' ? result : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function queryPathSnapshot(path) {
  const pathExists = await readPathExistence(path);
  if (pathExists !== true) return buildSnapshot(path, null, pathExists);
  if (!statPermissionAvailable) return buildSnapshot(path, null, true);
  let statTimeoutId;
  try {
    const info = await Promise.race([
      stat(path),
      new Promise((_, reject) => {
        statTimeoutId = setTimeout(() => reject(new Error('fs.stat timeout')), PATH_QUERY_TIMEOUT_MS);
      }),
    ]);
    return buildSnapshot(path, info, true);
  } catch (error) {
    if (String(error).includes('fs.stat not allowed')) {
      statPermissionAvailable = false;
    }
    // `exists` a établi la présence, même si les métadonnées restent illisibles.
    return buildSnapshot(path, null, true);
  } finally {
    clearTimeout(statTimeoutId);
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
  invalidateCachedSnapshot(key);
  inflightPathSnapshots.delete(key);
  window.dispatchEvent(new CustomEvent(FILE_CHANGED_EVENT, { detail: { path: normalizedPath } }));
}

function invalidateCachedSnapshot(key) {
  const snapshot = pathSnapshotCache.get(key);
  if (snapshot) snapshot.current = false;
  pathSnapshotCache.delete(key);
}

export async function readPathSnapshot(path, { maxAgeMs = 0, force = false } = {}) {
  const normalizedPath = readablePath(path);
  if (!normalizedPath) return buildSnapshot('', null, null);
  const key = cacheKey(normalizedPath);
  const cachedSnapshot = pathSnapshotCache.get(key);
  if (!force && isFresh(cachedSnapshot, maxAgeMs)) return cachedSnapshot;
  const inflight = inflightPathSnapshots.get(key);
  if (!force && inflight) return inflight;
  invalidateCachedSnapshot(key);

  const promise = queryPathSnapshot(normalizedPath)
    .then((snapshot) => {
      // Une requête remplacée ne peut plus publier dans le cache. L'audit
      // ignore également son résultat ; aucune table de lectures réglées
      // n'est conservée pour prolonger ce suivi.
      snapshot.current = inflightPathSnapshots.get(key) === promise;
      if (snapshot.current) {
        if (snapshot.exists !== null) pathSnapshotCache.set(key, snapshot);
        else pathSnapshotCache.delete(key);
      }
      return snapshot;
    })
    .finally(() => {
      if (inflightPathSnapshots.get(key) === promise) inflightPathSnapshots.delete(key);
    });
  inflightPathSnapshots.set(key, promise);
  return promise;
}
