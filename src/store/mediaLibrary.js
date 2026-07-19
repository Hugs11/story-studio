import { visitProjectEntries, walkProjectMediaReferences } from './projectModel/index.js';
import { isOriginalBackup } from '../utils/mediaConventions.js';
import { basename, pathKey, stripWindowsLongPathPrefix } from '../utils/fileUtils.js';

const EDITED_IMAGE_TAG = 'modifiée';

function getMediaTagsForPath(mediaTags, path) {
  if (!mediaTags || !path) return [];
  const key = pathKey(path);
  const matchingEntry = Object.entries(mediaTags)
    .find(([tagPath]) => pathKey(tagPath) === key);
  return matchingEntry?.[1] ?? [];
}

export function getEditedImageTags(mediaTags, sourcePath) {
  return [...new Set([
    ...getMediaTagsForPath(mediaTags, sourcePath),
    EDITED_IMAGE_TAG,
  ])];
}

function hasPath(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function extname(path) {
  const file = basename(path);
  const index = file.lastIndexOf('.');
  return index >= 0 ? file.slice(index + 1).toLowerCase() : '';
}

function mediaKind(path) {
  const ext = extname(path);
  if (['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'].includes(ext)) return 'image';
  if (['mp3', 'ogg', 'wav', 'm4a', 'webm', 'flac'].includes(ext)) return 'audio';
  if (['zip', '7z'].includes(ext)) return 'archive';
  return 'other';
}

// 'ai' = ComfyUI/XTTS result · 'recorded' = enregistrements/ · 'imported' = fichiers-importes/ · 'project' = referenced in project node · 'library' = extra standalone path
function detectOrigin(path, source) {
  if (source === 'XTTS' || source === 'ComfyUI') return 'ai';
  const norm = path.replace(/\\/g, '/').toLowerCase();
  if (norm.includes('/enregistrements/')) return 'recorded';
  if (norm.includes('/fichiers-importes/')) return 'imported';
  if (source === 'Explorateur') return 'library';
  return 'project';
}

function addMedia(map, path, label, source, field, statusByPath = {}, isProjectRef = false, entryId = null, options = {}) {
  if (!hasPath(path)) return;
  // Backups d'édition audio (`*.original.{ext}`) : masqués sauf s'ils sont explicitement
  // référencés par une entrée projet (pour ne jamais rendre invisible une référence existante).
  if (!isProjectRef && !options.allowOriginalBackup && isOriginalBackup(path)) return;
  const checkedPath = stripWindowsLongPathPrefix(path);
  const key = checkedPath.replace(/\\/g, '/').toLowerCase();
  const existing = map.get(key);
  const usage = { label, source, field, ...(entryId ? { entryId } : {}) };
  if (existing) {
    // Le catalogue durable indique seulement que Story Studio connaît le fichier.
    // Ce n'est pas un usage supplémentaire et il ne doit donc pas gonfler les badges.
    if (options.catalogOnly) return;
    existing.usages.push(usage);
    existing.usedCount = existing.usages.length;
    if (isProjectRef) {
      existing.inProject = true;
      existing.projectUsedCount += 1;
    }
    return;
  }
  map.set(key, {
    id: key,
    path,
    name: basename(path),
    kind: mediaKind(path),
    ext: extname(path),
    source,
    field,
    origin: detectOrigin(path, source),
    usages: options.catalogOnly ? [] : [usage],
    usedCount: options.catalogOnly ? 0 : 1,
    projectUsedCount: isProjectRef ? 1 : 0,
    inProject: isProjectRef,
    exists: statusByPath[path] !== false && statusByPath[checkedPath] !== false,
  });
}

function collectProjectMediaPaths(project) {
  const paths = [];
  const seen = new Set();
  for (const reference of walkProjectMediaReferences(project)) {
    if (!hasPath(reference?.path)) continue;
    const key = pathKey(reference.path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    paths.push(reference.path);
  }
  return paths;
}

export function mergeMediaLibraryPaths(...pathGroups) {
  const paths = [];
  const seen = new Set();
  for (const group of pathGroups) {
    for (const path of group ?? []) {
      if (!hasPath(path)) continue;
      const key = pathKey(path);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      paths.push(path);
    }
  }
  return paths;
}

export function reconcileMediaLibraryPaths(project, mediaLibraryPaths = []) {
  return mergeMediaLibraryPaths(mediaLibraryPaths, collectProjectMediaPaths(project));
}

export async function executeMediaDeletion({
  item,
  deleteFromDisk = false,
  deleteDisk,
  commitRemoval,
}) {
  if (!item?.path) {
    return { removed: false, blocked: false, diskDeleted: false, diskError: null };
  }
  if (item.inProject || item.projectUsedCount > 0) {
    return {
      removed: false,
      blocked: true,
      diskDeleted: false,
      diskError: null,
      usedCount: item.projectUsedCount || 1,
    };
  }

  if (deleteFromDisk) {
    try {
      await deleteDisk?.();
    } catch (error) {
      const message = typeof error === 'string' ? error : (error?.message || String(error));
      return { removed: false, blocked: false, diskDeleted: false, diskError: message };
    }
  }

  commitRemoval?.();
  return {
    removed: true,
    blocked: false,
    diskDeleted: deleteFromDisk,
    diskError: null,
  };
}

export function collectMediaLibrary({ project, statusByPath = {}, sdJobs = [], xttsJobs = [], extraPaths = [] }) {
  const map = new Map();
  addMedia(map, project?.rootAudio, 'Accueil', 'Projet', 'rootAudio', statusByPath, true);
  addMedia(map, project?.rootImage, 'Accueil', 'Projet', 'rootImage', statusByPath, true);
  addMedia(map, project?.thumbnailImage, 'Bibliothèque', 'Projet', 'thumbnailImage', statusByPath, true);
  addMedia(map, project?.nightModeAudio, 'Mode nuit', 'Projet', 'nightModeAudio', statusByPath, true);

  const addGraph = (graph, scope) => {
    for (const stage of graph?.document?.stageNodes ?? []) {
      const label = `${scope} · ${stage.name || stage.uuid || 'Stage natif'}`;
      addMedia(map, stage.audio, label, 'Graphe natif', 'audio', statusByPath, true);
      addMedia(map, stage.image, label, 'Graphe natif', 'image', statusByPath, true);
    }
  };
  addGraph(project?.nativeGraph, 'Racine');

  visitProjectEntries(project, (entry) => {
    const label = entry?.name || (entry?.type === 'menu' ? 'Menu sans titre' : entry?.type === 'zip' ? 'Archive importée' : 'Histoire sans titre');
    const eid = entry?.id || null;
    addMedia(map, entry?.audio, label, entry?.type || 'Projet', 'audio', statusByPath, true, eid);
    addMedia(map, entry?.image, label, entry?.type || 'Projet', 'image', statusByPath, true, eid);
    addMedia(map, entry?.itemAudio, label, 'Titre histoire', 'itemAudio', statusByPath, true, eid);
    addMedia(map, entry?.itemImage, label, 'Titre histoire', 'itemImage', statusByPath, true, eid);
    addMedia(map, entry?.zipPath, label, 'Archive', 'zipPath', statusByPath, true, eid);
    addMedia(map, entry?.afterPlaybackPromptAudio, label, 'Fin histoire', 'afterPlaybackPromptAudio', statusByPath, true, eid);
    addGraph(entry?.nativeGraph, label);
    for (const step of entry?.afterPlaybackSequence ?? []) {
      addMedia(map, step.audio, `${label} · ${step.name || 'Étape de fin'}`, 'Fin histoire', 'audio', statusByPath, true, eid);
      addMedia(map, step.image, `${label} · ${step.name || 'Étape de fin'}`, 'Fin histoire', 'image', statusByPath, true, eid);
    }
    addMedia(map, entry?.afterPlaybackHomeStep?.audio, `${label} · Home`, 'Fin histoire', 'audio', statusByPath, true, eid);
    addMedia(map, entry?.afterPlaybackHomeStep?.image, `${label} · Home`, 'Fin histoire', 'image', statusByPath, true, eid);
  });

  for (const job of xttsJobs) {
    if (job?.status === 'done' && hasPath(job.resultPath)) {
      addMedia(map, job.resultPath, job.targetLabel || job.label || 'Voix générée', 'XTTS', 'audio', statusByPath, false);
    }
  }
  for (const job of sdJobs) {
    for (const path of job?.resultPaths ?? []) {
      addMedia(map, path, job.workflowName || 'Image générée', 'ComfyUI', 'image', statusByPath, false);
    }
  }
  for (const path of extraPaths) {
    addMedia(map, path, 'Bibliothèque média', 'Explorateur', 'library', statusByPath, false, null, {
      allowOriginalBackup: true,
      catalogOnly: true,
    });
  }

  return [...map.values()].sort((a, b) => {
    const kindOrder = { image: 0, audio: 1, archive: 2, other: 3 };
    return (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9)
      || a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' });
  });
}
