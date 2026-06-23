// Pure decision helpers for the autosave loop.
// The React hook useAutosave() consumes these directly so the branching is
// covered by Node-side tests without spinning up the Tauri/React runtime.

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
