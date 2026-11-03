import { useEffect, useMemo, useState } from 'react';
import { hasUnsavedWork, createWorkSnapshot } from '../store/projectHelpers.js';
import { loadProjectFromPath } from '../store/projectIO.js';
import { projectToRustExport } from '../store/projectModel/schema.js';
import { buildExportRequest } from '../store/advancedExport/exportRequest.js';
import { catalogueOpenApi } from '../store/catalogue/catalogueOpenApi.js';

/** Evidence is captured from the exact disk read checked against the queued input. */
export function useCatalogueGeneration({ readProject, savePathRef, savedSnapshotRef, mediaLibraryPathsRef, mediaTagsRef, api = catalogueOpenApi(), loadSaved = loadProjectFromPath }) {
  const [snapshot, setSnapshot] = useState(null);
  useEffect(() => {
    const projectPath = savePathRef.current;
    const saved = savedSnapshotRef.current;
    const clean = Boolean(projectPath && saved !== null && !hasUnsavedWork({ project: readProject(), mediaLibraryPaths: mediaLibraryPathsRef.current, mediaTags: mediaTagsRef.current, savedSnapshot: saved }));
    setSnapshot(previous => previous?.projectPath === projectPath && previous?.saved === saved && previous?.clean === clean ? previous : { projectPath, saved, clean });
  });
  return useMemo(() => {
    if (!snapshot?.clean) return null;
    const { projectPath, saved } = snapshot;
    const readWork = () => ({ project: readProject(), mediaLibraryPaths: mediaLibraryPathsRef.current, mediaTags: mediaTagsRef.current, savedSnapshot: savedSnapshotRef.current });
    const current = () => projectPath && savePathRef.current === projectPath && saved !== null && savedSnapshotRef.current === saved && !hasUnsavedWork(readWork());
    const callback = async ({ projectPath: generatedPath, outputPath, generatedProjectJson, generatedOutputFingerprint }) => {
      if (generatedPath !== projectPath || !current() || typeof generatedProjectJson !== 'string') return;
      try { await api.recordGeneration({ projectPath, outputPath, generatedProjectJson, generatedOutputFingerprint }); } catch { /* best effort */ }
    };
    // Called by the executor immediately before invoking the engine, not after
    // generation. A later file version must never become the generated version.
    callback.prepare = async (job) => {
      if (job.savePath !== projectPath || !current()) return null;
      const loaded = await loadSaved(projectPath, { includeSourceText: true });
      if (!current() || createWorkSnapshot(loaded.data, loaded.mediaLibraryPaths, loaded.mediaTags) !== saved) return null;
      const actual = job.request ?? null;
      const expected = actual
        ? buildExportRequest({ project: loaded.data, outputFolder: actual.outputFolder, options: actual.options, archiveName: actual.archiveName, storyTitle: actual.storyTitle })
        : projectToRustExport(loaded.data);
      if (JSON.stringify(expected) !== (actual ? JSON.stringify(actual) : job.projectJson)) return null;
      return loaded.sourceText ?? null;
    };
    return callback;
  }, [snapshot, readProject, savePathRef, savedSnapshotRef, mediaLibraryPathsRef, mediaTagsRef, api, loadSaved]);
}
