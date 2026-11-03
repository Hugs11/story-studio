import { useSyncExternalStore } from 'react';
import { initialFilterState, filterStateReducer } from '../store/catalogue/filterState.js';

// Session lifetime exceeds CatalogueScreen's mounting lifetime. The editing
// flow must reuse this hook when returning to the catalogue; no storage write occurs here.
let session = initialFilterState();
const listeners = new Set();
const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
const snapshot = () => session;
function dispatch(action) {
  session = filterStateReducer(session, action);
  for (const listener of listeners) listener();
}
export function useCatalogueFilters() {
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  return { state, dispatch };
}
