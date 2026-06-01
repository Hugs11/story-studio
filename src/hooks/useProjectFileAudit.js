import { useEffect, useMemo, useState } from 'react';
import { visitProjectEntries } from '../store/projectModel';
import { FILE_REFRESH_THROTTLE_MS, hasFreshPathSnapshot, readPathSnapshot } from '../store/fileMetadataCache';
import { dirname, joinPath } from '../utils/fileUtils';

const FILE_AUDIT_CONCURRENCY = 16;

function hasPath(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function collectProjectPaths(project, projectIndex = null, savePath = null) {
  const projectDir = dirname(savePath);
  const paths = new Set();

  if (hasPath(project?.rootAudio)) paths.add(project.rootAudio);
  if (hasPath(project?.rootImage)) paths.add(project.rootImage);
  if (hasPath(project?.thumbnailImage)) paths.add(project.thumbnailImage);
  if (hasPath(project?.nightModeAudio)) paths.add(project.nightModeAudio);
  const addNativeGraphPaths = (graph) => {
    for (const stage of graph?.document?.stageNodes ?? []) {
      if (hasPath(stage?.audio)) paths.add(stage.audio);
      if (hasPath(stage?.image)) paths.add(stage.image);
    }
  };
  addNativeGraphPaths(project?.nativeGraph);

  visitProjectEntries(project, (entry) => {
    if (entry?.type === 'menu') {
      if (hasPath(entry.audio)) paths.add(entry.audio);
      if (hasPath(entry.image)) paths.add(entry.image);
      addNativeGraphPaths(entry.nativeGraph);
      return;
    }
    if (entry?.type === 'zip') {
      if (hasPath(entry.zipPath)) paths.add(entry.zipPath);
      return;
    }
    if (hasPath(entry?.audio)) paths.add(entry.audio);
    if (hasPath(entry?.image)) paths.add(entry.image);
    if (hasPath(entry?.itemAudio)) paths.add(entry.itemAudio);
    if (hasPath(entry?.itemImage)) paths.add(entry.itemImage);
    if (hasPath(entry?.afterPlaybackPromptAudio)) paths.add(entry.afterPlaybackPromptAudio);
    for (const step of entry?.afterPlaybackSequence ?? []) {
      if (hasPath(step?.audio)) paths.add(step.audio);
      if (hasPath(step?.image)) paths.add(step.image);
    }
    if (hasPath(entry?.afterPlaybackHomeStep?.audio)) paths.add(entry.afterPlaybackHomeStep.audio);
    if (hasPath(entry?.afterPlaybackHomeStep?.image)) paths.add(entry.afterPlaybackHomeStep.image);
  }, projectIndex);

  return [...paths].map((sourcePath) => {
    const trimmedPath = sourcePath.trim();
    const auditPath = projectDir && (trimmedPath.startsWith('./') || trimmedPath.startsWith('../'))
      ? joinPath(projectDir, trimmedPath.replace(/^\.\//, ''))
      : trimmedPath;
    return { sourcePath, auditPath };
  });
}

function areStatusMapsEqual(previousStatus, nextStatus) {
  const previousKeys = Object.keys(previousStatus);
  const nextKeys = Object.keys(nextStatus);
  if (previousKeys.length !== nextKeys.length) return false;
  return nextKeys.every((path) => previousStatus[path] === nextStatus[path]);
}

export function useProjectFileAudit(project, projectIndex = null, savePath = null) {
  const [statusByPath, setStatusByPath] = useState({});
  const [pending, setPending] = useState(false);
  const paths = useMemo(() => collectProjectPaths(project, projectIndex, savePath), [project, projectIndex, savePath]);

  useEffect(() => {
    let cancelled = false;

    async function runAudit({ allowThrottle = false } = {}) {
      if (paths.length === 0) {
        setStatusByPath((previousStatus) => (Object.keys(previousStatus).length === 0 ? previousStatus : {}));
        setPending(false);
        return;
      }

      const shouldShowPending = !allowThrottle || paths.some(({ auditPath }) => !hasFreshPathSnapshot(auditPath, FILE_REFRESH_THROTTLE_MS));
      if (shouldShowPending) setPending(true);

      const snapshots = [];
      let nextPathIndex = 0;
      const workerCount = Math.min(FILE_AUDIT_CONCURRENCY, paths.length);
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextPathIndex < paths.length) {
          const { sourcePath, auditPath } = paths[nextPathIndex];
          nextPathIndex += 1;
          const snapshot = await readPathSnapshot(auditPath, {
            maxAgeMs: allowThrottle ? FILE_REFRESH_THROTTLE_MS : 0,
          });
          snapshots.push({ sourcePath, exists: snapshot.exists });
        }
      }));

      if (cancelled) return;
      const nextStatus = Object.fromEntries(snapshots.map((snapshot) => [snapshot.sourcePath, snapshot.exists]));
      setStatusByPath((previousStatus) => (
        areStatusMapsEqual(previousStatus, nextStatus) ? previousStatus : nextStatus
      ));
      setPending(false);
    }

    function handleFocus() {
      void runAudit({ allowThrottle: true });
    }

    // Au premier audit après changement de projet, on veut l'état réel du disque,
    // pas un snapshot éventuellement réutilisé depuis un état précédent.
    void runAudit({ allowThrottle: false });
    window.addEventListener('focus', handleFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', handleFocus);
    };
  }, [paths]);

  return { statusByPath, pending };
}
