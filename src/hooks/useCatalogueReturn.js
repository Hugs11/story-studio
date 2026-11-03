import { useEffect, useRef } from 'react';
import { browseSession, reconcileBrowseSession } from '../store/catalogue/browseSession.js';

/** Snapshot belongs to the running application, not the screen's lifetime. */
export function useCatalogueReturn(snapshot, { ready, order, onRestore }) {
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const restored = useRef(false);
  const restore = useRef(onRestore);
  restore.current = onRestore;
  useEffect(() => {
    if (!ready || restored.current) return;
    restored.current = true;
    const saved = browseSession.restore();
    if (saved) restore.current(reconcileBrowseSession(saved,order));
  }, [ready, order]);
  useEffect(() => () => { browseSession.save(latest.current); }, []);
}
