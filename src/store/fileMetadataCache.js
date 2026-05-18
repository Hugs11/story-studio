import { exists, stat } from '@tauri-apps/plugin-fs';

export const FILE_REFRESH_THROTTLE_MS = 1500;

const pathSnapshotCache = new Map();
const inflightPathSnapshots = new Map();
let statPermissionAvailable = true;

function normalizePath(path) {
  return typeof path === 'string' ? path.trim() : '';
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
    const pathExists = await exists(path);
    if (!pathExists) {
      return buildSnapshot(path, null, false);
    }
    if (!statPermissionAvailable) {
      return buildSnapshot(path, null, true);
    }
    try {
      const info = await stat(path);
      return buildSnapshot(path, info, true);
    } catch (error) {
      if (String(error).includes('fs.stat not allowed')) {
        statPermissionAvailable = false;
      }
      return buildSnapshot(path, null, true);
    }
  } catch (error) {
    return buildSnapshot(path, null, false);
  }
}

export function getCachedPathSnapshot(path) {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) return null;
  return pathSnapshotCache.get(normalizedPath) ?? null;
}

export function hasFreshPathSnapshot(path, maxAgeMs = FILE_REFRESH_THROTTLE_MS) {
  return isFresh(getCachedPathSnapshot(path), maxAgeMs);
}

export function didPathSnapshotChange(previousSnapshot, nextSnapshot) {
  if (!previousSnapshot && !nextSnapshot) return false;
  if (!previousSnapshot || !nextSnapshot) return true;
  return previousSnapshot.exists !== nextSnapshot.exists
    || previousSnapshot.size !== nextSnapshot.size
    || previousSnapshot.mtimeMs !== nextSnapshot.mtimeMs;
}

export async function readPathSnapshot(path, { maxAgeMs = 0, force = false } = {}) {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) return buildSnapshot('', null, false);

  const cachedSnapshot = pathSnapshotCache.get(normalizedPath);
  if (!force && isFresh(cachedSnapshot, maxAgeMs)) {
    return cachedSnapshot;
  }

  const inflight = inflightPathSnapshots.get(normalizedPath);
  if (inflight) return inflight;

  const promise = queryPathSnapshot(normalizedPath)
    .then((snapshot) => {
      pathSnapshotCache.set(normalizedPath, snapshot);
      inflightPathSnapshots.delete(normalizedPath);
      return snapshot;
    })
    .catch((error) => {
      inflightPathSnapshots.delete(normalizedPath);
      throw error;
    });

  inflightPathSnapshots.set(normalizedPath, promise);
  return promise;
}
