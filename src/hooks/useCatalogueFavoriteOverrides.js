import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NO_FAVORITE_OVERRIDES, reconcileFavoriteOverrides, settleFavoriteOverrides, withFavoriteOverrides, withoutFavoriteOverrides } from '../store/catalogue/favoriteOverrides.js';

/**
 * Pending favorite values shown before the list carries them
 * (favoriteOverrides.js). `cards`/`revision`: the loaded list, without overrides.
 */
export function useCatalogueFavoriteOverrides(cards, revision) {
  const [overrides, setOverrides] = useState(NO_FAVORITE_OVERRIDES);
  const list = useRef({ cards, revision });
  list.current = { cards, revision: revision ?? null };
  useEffect(() => { setOverrides(current => reconcileFavoriteOverrides(current, cards, revision ?? null)); }, [cards, revision]);
  const set = useCallback((ids, value) => setOverrides(current => withFavoriteOverrides(current, ids, value)), []);
  // The list may already have caught up (reload awaited before settling).
  const settle = useCallback((ids, value, committed) => setOverrides(current =>
    reconcileFavoriteOverrides(settleFavoriteOverrides(current, ids, value, committed), list.current.cards, list.current.revision)), []);
  const clear = useCallback((ids, value) => setOverrides(current => withoutFavoriteOverrides(current, ids, value)), []);
  return useMemo(() => ({ overrides, set, settle, clear }), [overrides, set, settle, clear]);
}
