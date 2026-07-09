import { useCallback, useState } from 'react';
import { collectSessionOnlyMedia, applySessionMediaTriage } from '../store/sessionMediaTriage';
import { copyMediaToWorkspace } from '../store/projectIO';
import { FICHIERS_IMPORTES } from '../store/workspaceDirs';
import { pathKey } from '../utils/fileUtils';
import { logger } from '../utils/logger';

/**
 * Tri des médias de session à la promotion.
 *
 * `triageSessionMedia({ project, sessionDir, targetWorkspaceDir, projectName, transferCopies })`
 * - re-pointe bibliothèque et tags vers les fichiers déjà copiés par le
 *   transfert des médias référencés (`transferCopies`, pas de re-copie) ;
 * - détecte les orphelins restants (bibliothèque + clés de tags dans la
 *   session, non référencés) et propose le tri à l'utilisateur (modale) ;
 * - copie les conservés dans `fichiers-importes/` avec reprise : en cas
 *   d'échec, dialogue « Réessayer / Abandonner ces fichiers » jusqu'à
 *   résolution explicite — aucun fichier ne reste dans le dossier temporaire
 *   (purgé sous 24 h) sans décision.
 * Retourne `{ changed, mediaLibraryPaths?, mediaTags? }`.
 */
export function useSessionMediaTriage({ store, mediaLibraryPathsRef, setMediaLibraryPaths, showChoiceDialog }) {
  const [triageRequest, setTriageRequest] = useState(null); // null | { items, resolve }

  const triageSessionMedia = useCallback(async ({
    project,
    sessionDir,
    targetWorkspaceDir,
    projectName = '',
    transferCopies = [],
  }) => {
    const replacements = new Map();
    for (const copy of transferCopies) {
      if (copy?.from && copy?.to) replacements.set(pathKey(copy.from), copy.to);
    }

    const items = collectSessionOnlyMedia({
      project,
      mediaLibraryPaths: mediaLibraryPathsRef.current,
      mediaTags: store.mediaTags,
      sessionDir,
      excludeKeys: replacements,
    });

    const droppedPaths = [];
    if (items.length > 0) {
      const choice = await new Promise((resolve) => setTriageRequest({ items, resolve }));
      setTriageRequest(null);

      const keptKeys = new Set(choice.keptPaths.map((path) => pathKey(path)));
      for (const item of items) {
        if (!keptKeys.has(pathKey(item.path))) droppedPaths.push(item.path);
      }

      let pending = choice.keptPaths;
      while (pending.length > 0) {
        const failed = [];
        for (const path of pending) {
          try {
            const dest = await copyMediaToWorkspace(path, targetWorkspaceDir, FICHIERS_IMPORTES, projectName);
            replacements.set(pathKey(path), dest);
          } catch (error) {
            failed.push({ path, error: String(error) });
          }
        }
        if (failed.length === 0) break;
        logger.error(`session:triage-copy-errors count=${failed.length}`);
        const details = failed.slice(0, 5).map((item) => `• ${item.path}\n  ${item.error}`).join('\n');
        const action = await showChoiceDialog({
          title: 'Copie incomplète',
          message: 'Certains médias conservés n\'ont pas pu être copiés :\n\n'
            + details
            + '\n\nRéessayer, ou les abandonner (ils seront supprimés avec le dossier temporaire de session) ?',
          variant: 'warning',
          cancelValue: 'retry',
          actions: [
            { value: 'drop', label: 'Abandonner ces fichiers', kind: 'danger-outline' },
            { value: 'retry', label: 'Réessayer', kind: 'primary', autoFocus: true },
          ],
        });
        if (action === 'drop') {
          droppedPaths.push(...failed.map((item) => item.path));
          break;
        }
        pending = failed.map((item) => item.path);
      }
    }

    if (replacements.size === 0 && droppedPaths.length === 0) return { changed: false };

    const next = applySessionMediaTriage({
      mediaLibraryPaths: mediaLibraryPathsRef.current,
      mediaTags: store.mediaTags,
      replacements,
      droppedPaths,
    });
    const changed = droppedPaths.length > 0
      || JSON.stringify(next.mediaLibraryPaths) !== JSON.stringify(mediaLibraryPathsRef.current)
      || JSON.stringify(next.mediaTags) !== JSON.stringify(store.mediaTags);
    if (!changed) return { changed: false };

    store.setMediaTags(next.mediaTags);
    setMediaLibraryPaths(next.mediaLibraryPaths);
    mediaLibraryPathsRef.current = next.mediaLibraryPaths;
    logger.info(`session:triage rekeyed=${replacements.size} dropped=${droppedPaths.length}`);

    return {
      changed: true,
      mediaLibraryPaths: next.mediaLibraryPaths,
      mediaTags: next.mediaTags,
    };
  }, [mediaLibraryPathsRef, setMediaLibraryPaths, showChoiceDialog, store]);

  return { triageSessionMedia, triageRequest };
}
