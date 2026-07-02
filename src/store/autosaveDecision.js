// Pure decision helpers for the autosave loop.
// The React hook useAutosave() consumes these directly so the branching is
// covered by Node-side tests without spinning up the Tauri/React runtime.

import { visitProjectEntries } from './projectModel.js';

export const AUTOSAVE_ACTIONS = Object.freeze({
  SKIP_BUSY: 'skip-busy',
  SKIP_UNCHANGED: 'skip-unchanged',
  SKIP_EMPTY: 'skip-empty',
  SKIP_NO_TARGET: 'skip-no-target',
  SAVE_EXPLICIT: 'save-explicit',
  AUTOSAVE_EPHEMERAL: 'autosave-ephemeral',
  AUTOSAVE_EXISTING: 'autosave-existing',
  AUTOSAVE_NEW: 'autosave-new',
});

export function decideAutosaveAction({
  isSaving = false,
  currentSnapshot,
  savedSnapshot,
  isDirty = false,
  savePath = null,
  workspaceDir = null,
  autoSavePath = null,
  sessionMode = 'project',
  ephemeralSnapshotPath = null,
  lastEphemeralSnapshot = null,
} = {}) {
  if (isSaving) return { kind: AUTOSAVE_ACTIONS.SKIP_BUSY };
  if (currentSnapshot === savedSnapshot) return { kind: AUTOSAVE_ACTIONS.SKIP_UNCHANGED };
  if (sessionMode === 'ephemeral' && currentSnapshot === lastEphemeralSnapshot) {
    return { kind: AUTOSAVE_ACTIONS.SKIP_UNCHANGED };
  }
  if (!isDirty) return { kind: AUTOSAVE_ACTIONS.SKIP_EMPTY };
  if (savePath) return { kind: AUTOSAVE_ACTIONS.SAVE_EXPLICIT, path: savePath };
  if (sessionMode === 'ephemeral') {
    if (!workspaceDir || !ephemeralSnapshotPath) return { kind: AUTOSAVE_ACTIONS.SKIP_NO_TARGET };
    return { kind: AUTOSAVE_ACTIONS.AUTOSAVE_EPHEMERAL, path: ephemeralSnapshotPath, workspaceDir };
  }
  if (!workspaceDir) return { kind: AUTOSAVE_ACTIONS.SKIP_NO_TARGET };
  if (autoSavePath) return { kind: AUTOSAVE_ACTIONS.AUTOSAVE_EXISTING, path: autoSavePath };
  return { kind: AUTOSAVE_ACTIONS.AUTOSAVE_NEW, workspaceDir };
}

function hasPath(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// L'histoire pré-créée du mode simple (nom vide, aucun média) n'est pas un
// contenu utilisateur : sans ce filtre, une session simple vierge écrivait
// immédiatement un snapshot de récupération, proposé ensuite comme « projet
// récupérable » alors que rien n'a été saisi (plan 24).
function isPristinePlaceholderStory(entry) {
  return entry?.type === 'story'
    && !String(entry.name ?? '').trim()
    && !hasPath(entry.audio)
    && !hasPath(entry.itemAudio)
    && !hasPath(entry.itemImage);
}

export function isProjectWorthAutosaving(project, mediaLibraryPaths = [], totalMediaCount = 0) {
  if (!project) return false;
  // Check media presence before projectType so imported folders/AI media trigger autosave
  if (mediaLibraryPaths.length > 0) return true;
  if (totalMediaCount > 0) return true;
  if (project.projectType == null) return false;
  // Un nom saisi est déjà un contenu utilisateur (en mode simple, le champ
  // « Nom de l'histoire » écrit projectName, pas le nom de l'entrée story).
  if (String(project.projectName ?? '').trim() || String(project.packMetadata?.title ?? '').trim()) return true;
  if (hasPath(project.rootAudio) || hasPath(project.rootImage) || hasPath(project.thumbnailImage) || hasPath(project.nightModeAudio)) return true;
  let meaningfulCount = 0;
  visitProjectEntries(project, (entry) => {
    if (isPristinePlaceholderStory(entry)) return;
    meaningfulCount += 1;
  });
  return meaningfulCount > 0;
}

// Given a directory listing of backup files for the same baseName, returns the
// filenames that must be removed so that only `keep` most recent stay.
// Filenames sort lexicographically — backupProjectFile() always names them
// `<base>.<ISO-timestamp>.mbah`, so a plain sort yields chronological order.
export function selectStaleAutosaveBackups(entries, baseName, keep) {
  const keepCount = Math.max(0, Number(keep) || 0);
  const candidates = (entries ?? [])
    .filter((entry) => entry?.isFile && typeof entry.name === 'string')
    .filter((entry) => entry.name.startsWith(`${baseName}.`) && entry.name.endsWith('.mbah'))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  return candidates.slice(keepCount);
}
