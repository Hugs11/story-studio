import { useEffect } from 'react';
import { autoSaveEphemeralProject, autoSaveNewProject, getWorkspaceDir, saveProject } from '../store/projectIO';
import { isProjectDirty } from '../store/projectHelpers';
import { AUTOSAVE_ACTIONS, decideAutosaveAction } from '../store/autosaveDecision';
import { logger } from '../utils/logger';

export function useAutosave({
  enabled,
  backupLimit,
  projectRef,
  savedSnapshotRef,
  savePathRef,
  workspaceDirRef,
  autoSavePathRef,
  ephemeralSnapshotPathRef,
  ephemeralSnapshotSeedStateRef,
  sessionModeRef,
  isSavingRef,
  mediaTagsRef,
  mediaLibraryPathsRef,
  mediaLibraryCountRef,
  setAutoSavedPath,
  setSaveToast,
  saveHandlerRef,
}) {
  useEffect(() => {
    if (!enabled) return undefined;
    const interval = setInterval(async () => {
      const current = JSON.stringify(projectRef.current);
      const sessionMode = sessionModeRef?.current ?? 'project';
      const ephemeralSeedState = ephemeralSnapshotSeedStateRef?.current ?? null;
      const ephemeralSessionToken = ephemeralSeedState?.sessionToken ?? null;
      const workspaceDir = workspaceDirRef.current
        || (sessionMode === 'ephemeral' ? '' : await getWorkspaceDir().catch(() => ''))
        || null;
      const action = decideAutosaveAction({
        isSaving: isSavingRef.current,
        currentSnapshot: current,
        savedSnapshot: savedSnapshotRef.current,
        isDirty: isProjectDirty(projectRef.current),
        savePath: savePathRef.current,
        workspaceDir,
        autoSavePath: autoSavePathRef.current,
        sessionMode,
        ephemeralSnapshotPath: ephemeralSnapshotPathRef?.current ?? null,
        lastEphemeralSnapshot: ephemeralSeedState?.savedSnapshot ?? null,
      });
      switch (action.kind) {
        case AUTOSAVE_ACTIONS.SKIP_EMPTY:
          logger.warn('autosave:skip-empty-project');
          return;
        case AUTOSAVE_ACTIONS.SKIP_BUSY:
        case AUTOSAVE_ACTIONS.SKIP_UNCHANGED:
        case AUTOSAVE_ACTIONS.SKIP_NO_TARGET:
          return;
        case AUTOSAVE_ACTIONS.SAVE_EXPLICIT:
          saveHandlerRef.current?.({ silent: true });
          return;
        default:
          break;
      }
      // Project never manually saved — autosave to workspace/sauvegardes/ WITHOUT setting
      // store.savePath, so that recording/generation paths are never derived from the autosave file.
      try {
        if (action.kind === AUTOSAVE_ACTIONS.AUTOSAVE_EPHEMERAL) {
          await autoSaveEphemeralProject(projectRef.current, action.workspaceDir, action.path, {
            mediaTags: mediaTagsRef.current,
            mediaLibraryPaths: mediaLibraryPathsRef.current,
            totalMediaCount: mediaLibraryCountRef.current,
          });
          if (ephemeralSeedState
            && ephemeralSeedState.sessionToken === ephemeralSessionToken
            && sessionModeRef?.current === 'ephemeral'
            && ephemeralSnapshotPathRef?.current === action.path) {
            ephemeralSeedState.savedSnapshot = current;
          }
        } else if (action.kind === AUTOSAVE_ACTIONS.AUTOSAVE_EXISTING) {
          await saveProject(projectRef.current, action.path, null, {
            autosave: true,
            backupLimit,
            mediaTags: mediaTagsRef.current,
            mediaLibraryPaths: mediaLibraryPathsRef.current,
            totalMediaCount: mediaLibraryCountRef.current,
          });
          savedSnapshotRef.current = current;
          setAutoSavedPath(action.path);
        } else {
          const result = await autoSaveNewProject(projectRef.current, action.workspaceDir, {
            backupLimit,
            mediaTags: mediaTagsRef.current,
            mediaLibraryPaths: mediaLibraryPathsRef.current,
            totalMediaCount: mediaLibraryCountRef.current,
          });
          if (!result?.path) return;
          autoSavePathRef.current = result.path;
          savedSnapshotRef.current = JSON.stringify(result.project);
          setAutoSavedPath(result.path);
        }
        if (action.kind === AUTOSAVE_ACTIONS.AUTOSAVE_EPHEMERAL) return;
        setSaveToast('ok');
        setTimeout(() => setSaveToast(null), 2000);
      } catch (e) {
        logger.error('autosave:error', e);
      }
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [enabled, backupLimit]);
}
