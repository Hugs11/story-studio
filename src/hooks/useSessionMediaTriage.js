import { presentUserMessage } from '../i18n/userMessage.js';
import { translateMedia } from '../i18n/mediaPresentation.js';
import { useCallback, useRef, useState } from 'react';
import { collectSessionOnlyMedia, applySessionMediaTriage } from '../store/sessionMediaTriage';
import { copyMediaToWorkspace } from '../store/projectIO';
import { FICHIERS_IMPORTES } from '../store/workspaceDirs';
import { pathKey } from '../utils/fileUtils';
import { logger } from '../utils/logger';

/**
 * Tri des médias de session à la promotion.
 *
 * `triageSessionMedia({ project, sessionDir, targetWorkspaceDir, mediaStorage, transferCopies })`
 * - re-pointe bibliothèque et tags vers les fichiers déjà copiés par le
 *   transfert des médias référencés (`transferCopies`, pas de re-copie) ;
 * - détecte les orphelins restants (bibliothèque + clés de tags dans la
 *   session, non référencés) et propose le tri à l'utilisateur (modale) ;
 * - copie les conservés dans leur catégorie d’origine et le dossier projet
 *   capturés par la sauvegarde (origine externe → fichiers-importes), avec reprise : en cas
 *   d'échec, dialogue « Réessayer / Abandonner ces fichiers » jusqu'à
 *   résolution explicite — aucun fichier ne reste dans le dossier temporaire
 *   (purgé sous 24 h) sans décision.
 * Retourne `{ changed, mediaLibraryPaths?, mediaTags? }`.
 */
export function useSessionMediaTriage({ store, mediaLibraryPathsRef, setMediaLibraryPaths, showChoiceDialog }) {
  const [triageRequest, setTriageRequest] = useState(null); // null | { items, resolve }
  const liveStoreRef = useRef(store);
  liveStoreRef.current = store;

  const triageSessionMedia = useCallback(async ({
    project,
    sessionDir,
    targetWorkspaceDir,
    mediaStorage = null,
    transferCopies = [],
    isSessionCurrent = () => true,
  }) => {
    if (!isSessionCurrent()) return { changed: false };
    const replacements = new Map();
    for (const copy of transferCopies) {
      if (copy?.from && copy?.to) replacements.set(pathKey(copy.from), copy.to);
    }

    const items = collectSessionOnlyMedia({
      project,
      mediaLibraryPaths: mediaLibraryPathsRef.current,
      mediaTags: liveStoreRef.current.mediaTags,
      sessionDir,
      excludeKeys: replacements,
    });

    const droppedPaths = [];
    if (items.length > 0) {
      const choice = await new Promise((resolve) => setTriageRequest({ items, resolve }));
      setTriageRequest(null);
      if (!isSessionCurrent()) return { changed: false };

      const keptKeys = new Set(choice.keptPaths.map((path) => pathKey(path)));
      for (const item of items) {
        if (!keptKeys.has(pathKey(item.path))) droppedPaths.push(item.path);
      }

      let pending = choice.keptPaths;
      while (pending.length > 0) {
        const failed = [];
        for (const path of pending) {
          if (!isSessionCurrent()) return { changed: false };
          if (replacements.has(pathKey(path))) continue;
          try {
            const artifactCopies = [];
            const dest = await copyMediaToWorkspace(
              path,
              targetWorkspaceDir,
              FICHIERS_IMPORTES,
              { ...(mediaStorage ?? { root: targetWorkspaceDir, storage: project.storage, ephemeral: false }), sessionRoot: sessionDir },
              { artifactCopies },
            );
            replacements.set(pathKey(path), dest);
            for (const copy of artifactCopies) {
              replacements.set(pathKey(copy.from), copy.to);
            }
          } catch (error) {
            // Erreur d'origine retenue : présentée dans la langue active à l'affichage.
            failed.push({ path, error });
          }
        }
        if (!isSessionCurrent()) return { changed: false };
        if (failed.length === 0) break;
        logger.error(`session:triage-copy-errors count=${failed.length}`);
        const shownFailures = failed.slice(0, 5);
        const action = await showChoiceDialog({
          get title() { return translateMedia('media:triage.copy.incompleteTitle'); },
          get message() {
            const details = shownFailures.map((item) => `• ${item.path}\n  ${presentUserMessage(item.error).message}`).join('\n');
            return translateMedia('media:triage.copy.incompleteMessage', { details });
          },
          variant: 'warning',
          cancelValue: 'retry',
          actions: [
            { value: 'drop', get label() { return translateMedia('media:triage.copy.drop'); }, kind: 'danger-outline' },
            { value: 'retry', get label() { return translateMedia('media:triage.copy.retry'); }, kind: 'primary', autoFocus: true },
          ],
        });
        if (action === 'drop') {
          droppedPaths.push(...failed.map((item) => item.path));
          break;
        }
        pending = failed.map((item) => item.path);
      }
    }

    if (!isSessionCurrent()
      || (replacements.size === 0 && droppedPaths.length === 0)) return { changed: false };

    const next = applySessionMediaTriage({
      mediaLibraryPaths: mediaLibraryPathsRef.current,
      mediaTags: liveStoreRef.current.mediaTags,
      replacements,
      droppedPaths,
    });
    const changed = droppedPaths.length > 0
      || JSON.stringify(next.mediaLibraryPaths) !== JSON.stringify(mediaLibraryPathsRef.current)
      || JSON.stringify(next.mediaTags) !== JSON.stringify(liveStoreRef.current.mediaTags);
    if (!changed) return { changed: false };

    liveStoreRef.current.setMediaTags(next.mediaTags);
    setMediaLibraryPaths(next.mediaLibraryPaths);
    mediaLibraryPathsRef.current = next.mediaLibraryPaths;
    logger.info(`session:triage rekeyed=${replacements.size} dropped=${droppedPaths.length}`);

    return {
      changed: true,
      mediaLibraryPaths: next.mediaLibraryPaths,
      mediaTags: next.mediaTags,
      replacements,
    };
  }, [mediaLibraryPathsRef, setMediaLibraryPaths, showChoiceDialog, store]);

  return { triageSessionMedia, triageRequest };
}
