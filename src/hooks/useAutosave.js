import { useEffect } from 'react';
import { autoSaveEphemeralProject, autoSaveNewProject, getWorkspaceDir, saveProject } from '../store/projectIO';
import { createWorkSnapshot } from '../store/projectHelpers';
import { normalizeWorkProject } from '../store/projectWorkState';
import { AUTOSAVE_ACTIONS, decideAutosaveAction, isProjectWorthAutosaving } from '../store/autosaveDecision';
import {
  acceptEphemeralSnapshotSeed,
  beginEphemeralSnapshotSeed,
  enqueueEphemeralSnapshotWrite,
  finishEphemeralSnapshotSeed,
} from '../store/ephemeralSnapshotSeed';
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
  workEpochRef,
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
      // Même garde qu'un enregistrement explicite : un projet remplacé ou
      // réinitialisé pendant l'écriture ne reçoit ni le chemin d'autosave ni
      // l'instantané du travail précédent, faute de quoi la prochaine tick
      // écraserait le fichier d'un autre projet avec celui-ci.
      const workEpochAtStart = workEpochRef?.current ?? null;
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
          const writeEphemeral = async () => {
            // Le travail est relu au moment d'écrire, pas à la tick : un
            // instantané immédiat passé devant a peut-être déjà écrit plus
            // récent, et cette écriture ne doit jamais le remplacer par plus
            // ancien.
            const latestProject = projectRef.current;
            const latestPaths = mediaLibraryPathsRef.current;
            const latestTags = mediaTagsRef.current;
            const latest = createWorkSnapshot(latestProject, latestPaths, latestTags);
            const write = ephemeralSeedState
              ? beginEphemeralSnapshotSeed(ephemeralSeedState, {
                sessionMode: sessionModeRef?.current,
                path: ephemeralSnapshotPathRef?.current === action.path ? action.path : null,
                snapshot: latest,
              })
              : { path: action.path };
            if (!write) return;
            try {
              await autoSaveEphemeralProject(latestProject, action.workspaceDir, action.path, {
                mediaTags: latestTags,
                mediaLibraryPaths: latestPaths,
                totalMediaCount: mediaLibraryCountRef.current,
              });
              if (ephemeralSeedState && ephemeralSeedState.sessionToken === ephemeralSessionToken) {
                acceptEphemeralSnapshotSeed(ephemeralSeedState, write, {
                  sessionMode: sessionModeRef?.current,
                  path: ephemeralSnapshotPathRef?.current,
                });
              }
            } finally {
              if (ephemeralSeedState) finishEphemeralSnapshotSeed(ephemeralSeedState, write);
            }
          };
          if (ephemeralSeedState) {
            await enqueueEphemeralSnapshotWrite(ephemeralSeedState, async () => {
              if (ephemeralSeedState.sessionToken !== ephemeralSessionToken) return;
              await writeEphemeral();
            });
          } else {
            await writeEphemeral();
          }
        } else if (action.kind === AUTOSAVE_ACTIONS.AUTOSAVE_EXISTING) {
          await saveProject(project, action.path, null, {
            autosave: true,
            backupLimit,
            mediaTags,
            mediaLibraryPaths,
            totalMediaCount: mediaLibraryCountRef.current,
          });
          if ((workEpochRef?.current ?? null) !== workEpochAtStart) return;
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
          if ((workEpochRef?.current ?? null) !== workEpochAtStart) return;
          autoSavePathRef.current = result.path;
          autoSaveSnapshotRef.current = createWorkSnapshot(
            normalizeWorkProject(result.project),
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
