import { useCallback, useState } from 'react';
import { collectSessionOnlyMedia, applySessionMediaTriage } from '../store/sessionMediaTriage';
import { copyMediaToWorkspace } from '../store/projectIO';
import { FICHIERS_IMPORTES } from '../store/workspaceDirs';
import { pathKey } from '../utils/fileUtils';
import { logger } from '../utils/logger';

/**
 * Tri des médias de session à la promotion (plan 22, D51).
 *
 * `triageSessionMedia({ project, sessionDir, targetWorkspaceDir, projectName })`
 * détecte les médias de la bibliothèque qui vivent dans la session éphémère sans
 * être utilisés par un nœud, propose le tri à l'utilisateur (modale), copie les
 * conservés dans `fichiers-importes/` du workspace, et met à jour bibliothèque
 * + tags. Retourne `{ ok, changed, mediaLibraryPaths?, mediaTags? }` :
 * `ok === false` (copies en échec) doit empêcher le nettoyage de la session.
 */
export function useSessionMediaTriage({ store, mediaLibraryPathsRef, setMediaLibraryPaths, showErrorDialog }) {
  const [triageRequest, setTriageRequest] = useState(null); // null | { items, resolve }

  const triageSessionMedia = useCallback(async ({ project, sessionDir, targetWorkspaceDir, projectName = '' }) => {
    const items = collectSessionOnlyMedia({
      project,
      mediaLibraryPaths: mediaLibraryPathsRef.current,
      sessionDir,
    });
    if (items.length === 0) return { ok: true, changed: false };

    const choice = await new Promise((resolve) => setTriageRequest({ items, resolve }));
    setTriageRequest(null);

    const keptKeys = new Set(choice.keptPaths.map((path) => pathKey(path)));
    const replacements = new Map();
    const errors = [];
    for (const path of choice.keptPaths) {
      try {
        const dest = await copyMediaToWorkspace(path, targetWorkspaceDir, FICHIERS_IMPORTES, projectName);
        replacements.set(pathKey(path), dest);
      } catch (error) {
        errors.push({ path, error: String(error) });
      }
    }

    // Abandonnés = orphelins non cochés. Les cochés dont la copie a échoué
    // gardent leur chemin de session : la session n'est alors pas nettoyée
    // (ok=false), les fichiers restent accessibles.
    const droppedPaths = items
      .map((item) => item.path)
      .filter((path) => !keptKeys.has(pathKey(path)));

    const next = applySessionMediaTriage({
      mediaLibraryPaths: mediaLibraryPathsRef.current,
      mediaTags: store.mediaTags,
      replacements,
      droppedPaths,
    });
    store.setMediaTags(next.mediaTags);
    setMediaLibraryPaths(next.mediaLibraryPaths);
    mediaLibraryPathsRef.current = next.mediaLibraryPaths;

    if (errors.length > 0) {
      logger.error(`session:triage-copy-errors count=${errors.length}`);
      showErrorDialog({
        title: 'Copie incomplète',
        message: 'Certains médias conservés n\'ont pas pu être copiés :\n\n'
          + errors.slice(0, 5).map((error) => `• ${error.path}\n  ${error.error}`).join('\n')
          + '\n\nLe dossier temporaire de session est conservé pour ne rien perdre.',
        variant: 'warning',
      });
    }
    logger.info(`session:triage kept=${replacements.size} dropped=${droppedPaths.length} errors=${errors.length}`);

    return {
      ok: errors.length === 0,
      changed: true,
      mediaLibraryPaths: next.mediaLibraryPaths,
      mediaTags: next.mediaTags,
    };
  }, [mediaLibraryPathsRef, setMediaLibraryPaths, showErrorDialog, store]);

  return { triageSessionMedia, triageRequest };
}
