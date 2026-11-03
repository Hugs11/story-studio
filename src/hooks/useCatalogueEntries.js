import { useCallback, useEffect, useReducer, useRef } from 'react';
import { catalogueApi } from '../store/catalogue/catalogueApi.js';
import { createReloadScheduler, entriesReducer, INITIAL_ENTRIES_STATE } from '../store/catalogue/entriesState.js';

/**
 * Fiches du catalogue : chargement initial, puis rechargement regroupé à
 * chaque `catalogue-changed`. Pendant un rechargement, les fiches connues
 * restent affichées.
 * @returns {{status: 'loading'|'ready'|'error', cards: Array, revision: number|null,
 *   error: unknown, reloading: boolean}}
 */
export function useCatalogueEntries({ api = catalogueApi() } = {}) {
  const [state, dispatch] = useReducer(entriesReducer, INITIAL_ENTRIES_STATE);
  const apiRef = useRef(api);
  const reload = useRef(null);
  const schedulerRef = useRef(null);
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => {
    const controller = new AbortController();
    let opening = true;
    const scheduler = createReloadScheduler({
      run: async () => {
        if (opening) { opening = false; await apiRef.current.openCatalogue?.(); }
        dispatch({ type: 'loadStarted' });
        try {
          const { cards, revision } = await apiRef.current.listAllEntries({ signal: controller.signal });
          if (!controller.signal.aborted) dispatch({ type: 'loadSucceeded', cards, revision });
          return revision;
        } catch (error) {
          if (!controller.signal.aborted) dispatch({ type: 'loadFailed', error });
          return null;
        }
      },
    });
    const unsubscribe = apiRef.current.subscribeChanges(({ revision }) => scheduler.request(revision));
    reload.current = () => scheduler.now();
    schedulerRef.current = scheduler;
    scheduler.now();
    return () => {
      controller.abort();
      reload.current = null;
      schedulerRef.current = null;
      scheduler.dispose();
      unsubscribe();
    };
  }, []);

  /**
   * Applies a committed favorite change to the loaded list without reading it
   * again, when the mutation produced the very next revision. Returns false
   * otherwise: the caller then reloads.
   */
  const patchFavorite = useCallback(({ ids, value, revision }) => {
    const current = latest.current;
    // A load in progress may have read the list before this mutation: it would
    // overwrite the patch, so the caller reloads after it instead.
    const scheduler = schedulerRef.current;
    if (!scheduler || scheduler.isRunning() || current.status !== 'ready' || current.reloading || revision !== current.revision + 1) return false;
    latest.current = entriesReducer(current, { type: 'favoritePatched', ids, value, revision });
    dispatch({ type: 'favoritePatched', ids, value, revision });
    scheduler.markLoaded(revision);
    return true;
  }, []);

  return { ...state, refresh: () => reload.current?.(), patchFavorite };
}
