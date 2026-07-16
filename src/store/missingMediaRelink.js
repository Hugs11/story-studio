import { basename, joinPath, pathKey } from '../utils/fileUtils.js';
import { walkProjectMediaReferences } from './projectModel/index.js';
import { MANAGED_PROJECT_DIRS } from './workspaceDirs.js';

function hasPath(path) {
  return typeof path === 'string' && path.trim().length > 0;
}

function replacementForPath(path, replacements) {
  if (!hasPath(path)) return null;
  const key = pathKey(path);
  return replacements.get(key) ?? null;
}

export function mediaKindFromPath(path) {
  const ext = String(path || '').toLowerCase().replace(/^.*\./, '');
  if (['mp3', 'ogg', 'wav', 'm4a', 'webm', 'flac', 'aac'].includes(ext)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'].includes(ext)) return 'image';
  if (['zip', '7z'].includes(ext)) return 'archive';
  return 'media';
}

export function collectMissingMedia(project, statusByPath = {}) {
  const byPath = new Map();
  for (const ref of walkProjectMediaReferences(project)) {
    if (statusByPath?.[ref.path] !== false) continue;
    const key = pathKey(ref.path);
    const current = byPath.get(key) ?? {
      path: ref.path,
      fileName: basename(ref.path) || ref.path,
      kind: mediaKindFromPath(ref.path),
      labels: [],
      count: 0,
    };
    current.count += 1;
    if (ref.label && !current.labels.includes(ref.label)) current.labels.push(ref.label);
    byPath.set(key, current);
  }
  return [...byPath.values()].sort((a, b) => a.fileName.localeCompare(b.fileName, 'fr'));
}

function normalizeReplacementMap(replacements = {}) {
  if (replacements instanceof Map) {
    return new Map(
      [...replacements.entries()]
        .filter(([, next]) => hasPath(next))
        .map(([previous, next]) => [pathKey(previous), next]),
    );
  }
  return new Map(
    Object.entries(replacements)
      .filter(([, next]) => hasPath(next))
      .map(([previous, next]) => [pathKey(previous), next]),
  );
}

export function relinkProjectMedia(project, replacements = {}) {
  const map = normalizeReplacementMap(replacements);
  if (map.size === 0) return project;
  const next = structuredClone(project);
  for (const ref of walkProjectMediaReferences(next)) {
    const replacement = replacementForPath(ref.path, map);
    if (replacement) ref.obj[ref.key] = replacement;
  }
  return next;
}

export function relinkMediaTags(mediaTags = {}, replacements = {}) {
  const map = normalizeReplacementMap(replacements);
  if (map.size === 0 || !mediaTags || typeof mediaTags !== 'object') return mediaTags ?? {};
  const next = {};
  for (const [tagPath, tags] of Object.entries(mediaTags)) {
    const replacement = replacementForPath(tagPath, map);
    const nextPath = replacement ?? tagPath;
    next[nextPath] = [...new Set([...(next[nextPath] ?? []), ...tags])];
  }
  return next;
}

export function relinkMediaLibraryPaths(paths = [], replacements = {}) {
  const map = normalizeReplacementMap(replacements);
  if (map.size === 0 || !Array.isArray(paths)) return paths ?? [];
  return paths.map((path) => replacementForPath(path, map) ?? path);
}

export function candidatePathsForRelinkRoot(missingPath, selectedRoot) {
  if (!hasPath(missingPath) || !hasPath(selectedRoot)) return [];
  const normalized = String(missingPath).replace(/\\/g, '/');
  const candidates = [];
  for (const dirName of MANAGED_PROJECT_DIRS) {
    const marker = `/${dirName}/`;
    const markerIndex = normalized.toLowerCase().lastIndexOf(marker.toLowerCase());
    if (markerIndex >= 0) {
      candidates.push(joinPath(selectedRoot, normalized.slice(markerIndex + 1)));
    }
  }
  candidates.push(joinPath(selectedRoot, basename(missingPath)));
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = pathKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildRelinkSignature(missingMedia = []) {
  return missingMedia.map((item) => pathKey(item.path)).sort().join('|');
}
