import { visitProjectEntries } from './projectModel/index.js';
import { isOriginalBackup } from '../utils/mediaConventions.js';
import { pathKey } from '../utils/fileUtils.js';

export function classifyOsDroppedFiles(paths) {
  const ext = (p) => (String(p).split('.').pop() || '').toLowerCase();
  const AUDIO = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'webm']);
  const IMAGES = new Set(['png', 'jpg', 'jpeg', 'webp']);
  const ARCHIVES = new Set(['zip', '7z']);
  // Backups d'édition audio (`*.original.{ext}`) ignorés silencieusement.
  const filtered = paths.filter((p) => !isOriginalBackup(p));
  return {
    audio: filtered.filter((p) => AUDIO.has(ext(p))),
    images: filtered.filter((p) => IMAGES.has(ext(p))),
    archives: filtered.filter((p) => ARCHIVES.has(ext(p))),
  };
}

// Retourne true si le projet a du contenu (= mérite d'être sauvegardé)
export function isProjectDirty(project) {
  if (!project) return false;
  if (project.projectType !== null) return true;
  let hasEntries = false;
  visitProjectEntries(project, (entry) => {
    if (entry.type === 'story' || entry.type === 'zip' || entry.type === 'menu') hasEntries = true;
  });
  return !!project.projectName || !!project.rootAudio || !!project.rootImage || hasEntries;
}

function canonicalMediaLibraryPaths(paths) {
  const byKey = new Map();
  for (const path of Array.isArray(paths) ? paths : []) {
    if (typeof path !== 'string' || !path.trim()) continue;
    const key = pathKey(path);
    if (!byKey.has(key)) byKey.set(key, path);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key]) => key);
}

function canonicalMediaTags(mediaTags) {
  const tagsByPath = new Map();
  for (const [path, tags] of Object.entries(mediaTags && typeof mediaTags === 'object' ? mediaTags : {})) {
    if (typeof path !== 'string' || !path.trim()) continue;
    const key = pathKey(path);
    const merged = tagsByPath.get(key) ?? new Set();
    for (const tag of Array.isArray(tags) ? tags : []) {
      if (typeof tag === 'string') merged.add(tag);
    }
    tagsByPath.set(key, merged);
  }
  return Object.fromEntries(
    [...tagsByPath.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, tags]) => [path, [...tags].sort()]),
  );
}

// Signature de l'ensemble du travail persistant. Le catalogue Médias et ses
// tags font partie du document au même titre que l'arbre du projet.
export function createWorkSnapshot(project, mediaLibraryPaths = [], mediaTags = {}) {
  return JSON.stringify({
    project,
    mediaLibraryPaths: canonicalMediaLibraryPaths(mediaLibraryPaths),
    mediaTags: canonicalMediaTags(mediaTags),
  });
}

export function isSaveInputStillCurrent(inputAtSaveStart, currentInput) {
  return inputAtSaveStart === currentInput;
}

export function hasUnsavedWork({
  project,
  mediaLibraryPaths = [],
  mediaTags = {},
  savedSnapshot = null,
} = {}) {
  if (savedSnapshot !== null) {
    return createWorkSnapshot(project, mediaLibraryPaths, mediaTags) !== savedSnapshot;
  }
  return isProjectDirty(project)
    || canonicalMediaLibraryPaths(mediaLibraryPaths).length > 0
    || Object.keys(canonicalMediaTags(mediaTags)).length > 0;
}

export function hasExplicitExportPackName(project) {
  const metadata = project?.packMetadata ?? {};
  if (metadata.namingMode === 'legacy') return !!String(metadata.legacyExportName || '').trim();
  if (String(metadata.title || '').trim()) return true;
  if (project?.projectType === 'simple') return !!String(project?.projectName || '').trim();
  return false;
}

export function buildTransferPromptSignature(savePath, candidates) {
  return `${savePath}::${candidates.map((candidate) => candidate.path.toLowerCase()).sort().join('|')}`;
}

export function shouldAbortEphemeralPromotion({ isEphemeralSession = false, transferErrors = [] } = {}) {
  return !!isEphemeralSession && Array.isArray(transferErrors) && transferErrors.length > 0;
}
