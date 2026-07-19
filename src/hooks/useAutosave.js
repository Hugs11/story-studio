import { useEffect } from 'react';
import { autoSaveEphemeralProject, autoSaveNewProject, getWorkspaceDir, saveProject } from '../store/projectIO';
import { createWorkSnapshot } from '../store/projectHelpers';
import { AUTOSAVE_ACTIONS, decideAutosaveAction, isProjectWorthAutosaving } from '../store/autosaveDecision';
import { logger } from '../utils/logger';

export function useAutosave({
  enabled,
  backupLimit,
  projectRef,
  savedSnapshotRef,
  savePathRef,
  workspaceDirRef,
  autoSavePathRef,
  autoSaveSnapshotRef,
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
      const project = projectRef.current;
      const mediaLibraryPaths = mediaLibraryPathsRef.current;
      const mediaTags = mediaTagsRef.current;
      const current = createWorkSnapshot(project, mediaLibraryPaths, mediaTags);
      const sessionMode = sessionModeRef?.current ?? 'project';
      const ephemeralSeedState = ephemeralSnapshotSeedStateRef?.current ?? null;
      const ephemeralSessionToken = ephemeralSeedState?.sessionToken ?? null;
      const workspaceDir = workspaceDirRef.current
        || (sessionMode === 'ephemeral' ? '' : await getWorkspaceDir().catch(() => ''))
        || null;
      const action = decideAutosaveAction({
        isSaving: isSavingRef.current,
        currentSnapshot: current,
        savedSnapshot: savePathRef.current
          ? savedSnapshotRef.current
          : autoSaveSnapshotRef.current,
        isDirty: isProjectWorthAutosaving(project, mediaLibraryPaths, mediaLibraryCountRef.current)
          || Object.keys(mediaTags ?? {}).length > 0,
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
          await autoSaveEphemeralProject(project, action.workspaceDir, action.path, {
            mediaTags,
            mediaLibraryPaths,
            totalMediaCount: mediaLibraryCountRef.current,
          });
          if (ephemeralSeedState
            && ephemeralSeedState.sessionToken === ephemeralSessionToken
            && sessionModeRef?.current === 'ephemeral'
            && ephemeralSnapshotPathRef?.current === action.path) {
            ephemeralSeedState.savedSnapshot = current;
          }
        } else if (action.kind === AUTOSAVE_ACTIONS.AUTOSAVE_EXISTING) {
          await saveProject(project, action.path, null, {
            autosave: true,
            backupLimit,
            mediaTags,
            mediaLibraryPaths,
            totalMediaCount: mediaLibraryCountRef.current,
          });
          autoSaveSnapshotRef.current = current;
          setAutoSavedPath(action.path);
        } else {
          const result = await autoSaveNewProject(project, action.workspaceDir, {
            backupLimit,
            mediaTags,
            mediaLibraryPaths,
            totalMediaCount: mediaLibraryCountRef.current,
          });
          if (!result?.path) return;
          autoSavePathRef.current = result.path;
          autoSaveSnapshotRef.current = createWorkSnapshot(
            result.project,
            result.mediaLibraryPaths ?? mediaLibraryPaths,
            mediaTags,
          );
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
