import { useEffect, useRef, useState, useCallback } from 'react';
import { catalogueDataApi } from '../store/catalogue/catalogueDataApi.js';
import { createReloadScheduler } from '../store/catalogue/entriesState.js';
import { catalogueApi } from '../store/catalogue/catalogueApi.js';

// Engine verdicts per exemplar id, from a card read with its archives counted.
function removalsOf(card) {
  return Object.fromEntries((card?.exemplars ?? []).map(exemplar => [exemplar.id, exemplar.archiveRemoval ?? null]));
}

/**
 * Fiche detail. With `inspectArchives`, the counting of the packs held by its
 * archives (slow: `7z l`, nested ZIP) follows the card instead of delaying it;
 * `archiveRemovals` stays null until it answers for the displayed revision, the
 * catalogue decision applying meanwhile (the trash plan recounts anyway).
 */
export function useCatalogueCard(ficheId, api = catalogueDataApi, { inspectArchives = false } = {}) {
  const [state, setState] = useState({ card: null, error: null });
  const [inspection, setInspection] = useState(null);
  const generation = useRef(0);
  const slot = useRef({ running: false, again: false });
  const inspect = useCallback(() => {
    const current = slot.current;
    if (current.running) { current.again = true; return; }
    current.running = true;
    api.getCard(ficheId, { inspectArchives: true })
      .then(card => { if (slot.current === current) setInspection({ ficheId, catalogueRevision: card.catalogueRevision, removals: removalsOf(card) }); })
      // Display only: a failed count leaves the catalogue decision.
      .catch(() => {})
      .finally(() => {
        current.running = false;
        if (current.again && slot.current === current) { current.again = false; inspect(); }
      });
  }, [ficheId, api]);
  const reload = useCallback(async () => {
    const current = ++generation.current;
    try {
      const card = await api.getCard(ficheId);
      if (current === generation.current) {
        setState({ card, error: null, ficheId });
        if (inspectArchives) inspect();
      }
      return card;
    } catch (error) { if (current === generation.current) setState(s => ({ ...s, error })); throw error; }
  }, [ficheId, api, inspectArchives, inspect]);
  useEffect(() => {
    if (!ficheId) return;
    const scheduler = createReloadScheduler({ run: () => reload().then(card => card.catalogueRevision).catch(() => null) });
    void scheduler.now();
    const stop = catalogueApi().subscribeChanges(({ revision }) => scheduler.request(revision));
    return () => { generation.current++; slot.current = { running: false, again: false }; scheduler.dispose(); stop(); };
  }, [ficheId, reload]);
  const card = state.ficheId === ficheId ? state.card : null;
  // A count obtained for another fiche or revision never replaces a newer card's.
  const archiveRemovals = card && inspection?.ficheId === ficheId && inspection.catalogueRevision === card.catalogueRevision ? inspection.removals : null;
  return { ...state, card, archiveRemovals, reload };
}
