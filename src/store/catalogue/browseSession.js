import { normalizeFilters } from './filters.js';
import { normalizeView } from './viewModes.js';
import { EMPTY_SELECTION, pruneSelection, prunedAnnouncement } from './selection.js';

/** In-memory owner, deliberately independent of the screen and persistent settings. */
export function createBrowseSession() {
  let snapshot = null;
  return {
    save(value) { snapshot = structuredClone(value); },
    restore() {
      if (snapshot === null) return null;
      const saved = structuredClone(snapshot);
      if (saved.view === 'details') saved.scroll = { ...saved.scroll, list: saved.scroll?.details ?? saved.scroll?.list ?? 0 };
      if (saved.filterState) saved.filterState.filters = normalizeFilters(saved.filterState.filters);
      saved.view = normalizeView(saved.view);
      return saved;
    },
    clear() { snapshot = null; },
  };
}

export const browseSession = createBrowseSession();

export function restoreScroll(snapshot, view, maximum = Infinity) {
  const position = snapshot?.scroll?.[view];
  return Math.min(Math.max(0, Number.isFinite(position) ? position : 0), Math.max(0, maximum));
}

/** Wait for the loaded result before pruning; an empty loading screen is not a deletion. */
export function reconcileBrowseSession(snapshot, visibleIds) {
  const { selection, removed } = pruneSelection(snapshot?.selection ?? EMPTY_SELECTION, visibleIds);
  const missingFocus = Boolean((snapshot?.focusedCardId && !visibleIds.includes(snapshot.focusedCardId)) || (snapshot?.ficheId && !visibleIds.includes(snapshot.ficheId)));
  return {
    ...snapshot,
    selection,
    focusedCardId: missingFocus ? null : snapshot?.focusedCardId ?? null,
    focusToolbar: missingFocus,
    announcement: prunedAnnouncement(removed),
  };
}
