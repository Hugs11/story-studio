import { visitProjectEntries } from './projectModel/index.js';
import { isOriginalBackup } from '../utils/mediaConventions.js';

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
  if (project.projectType !== null) return true;
  let hasEntries = false;
  visitProjectEntries(project, (entry) => {
    if (entry.type === 'story' || entry.type === 'zip' || entry.type === 'menu') hasEntries = true;
  });
  return !!project.projectName || !!project.rootAudio || !!project.rootImage || hasEntries;
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
