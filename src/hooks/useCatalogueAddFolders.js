import { useCallback, useEffect, useRef, useState } from 'react';
import { pickFolder, subscribeFolderDrops } from './useFileDialog.js';

/**
 * Ajout de dossiers depuis l'écran du catalogue : sélecteur natif (plusieurs
 * dossiers) ou dépôt sur la fenêtre. Chaque dossier passe par `add` (qui lance
 * son scan). `added` (0 = rien à montrer) change à chaque ajout abouti pour afficher le
 * message temporaire, `dismiss` le referme ; `onNotice` reçoit une annonce `{ key, params }` (ex. dossier
 * déjà suivi, élément qui n'est pas un dossier).
 */
export function useCatalogueAddFolders({ add, sources, onNotice, onError }) {
  const [added, setAdded] = useState(0);
  const latest = useRef({ add, sources, onNotice, onError });
  latest.current = { add, sources, onNotice, onError };
  const busy = useRef(false);
  const addPaths = useCallback(async (paths, { dropped }) => {
    if (busy.current) return;
    busy.current = true;
    try {
      for (const path of paths) {
        const { add: addSource, sources: current, onNotice: notify } = latest.current;
        if (current.some((source) => source.path === path && source.status === 'active')) { notify?.({ key: 'catalogue:sources.duplicate.message', params: {} }); continue; }
        const result = await addSource(path);
        if (!result) { if (dropped) notify?.({ key: 'catalogue:sources.folderOnly.message', params: {} }); continue; }
        if (!result.alreadyActive) setAdded((count) => count + 1);
      }
    } catch (error) { latest.current.onError?.(error); } finally { busy.current = false; }
  }, []);
  const choose = useCallback(async () => {
    if (busy.current) return;
    try {
      const selected = await pickFolder({ multiple: true });
      await addPaths(Array.isArray(selected) ? selected : selected ? [selected] : [], { dropped: false });
    } catch (error) { latest.current.onError?.(error); }
  }, [addPaths]);
  useEffect(() => {
    let stopped = false;
    let release;
    void subscribeFolderDrops((paths) => { if (!stopped) void addPaths(paths, { dropped: true }); })
      .then((stop) => { if (stopped) stop(); else release = stop; })
      .catch(() => { /* Pas de dépôt natif dans l'aperçu web. */ });
    return () => { stopped = true; release?.(); };
  }, [addPaths]);
  return { choose, added, dismiss: useCallback(() => setAdded(0), []) };
}
