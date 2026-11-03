import { useRef, useState } from 'react';
import { catalogueDataApi, REVISION_CONFLICT } from '../store/catalogue/catalogueDataApi.js';
import { selectionActions } from '../store/catalogue/selectionActions.js';
const MAX_REBASE = 20;
// Selection is owned by the browser. No mutation path clears it on failure.
// `optimistic` shows a favorite before the answer ({ set, settle, clear }): a
// committed value stays shown until the list carries it; `applyLocal`
// applies a committed outcome to the loaded list and returns true, which
// spares the full reload.
export function useCatalogueSelectionActions({ ids, cards, visibleIds, revision, onReload, onAnnounce, onError, onOutcome, onFailure, optimistic, applyLocal, api = catalogueDataApi }) {
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false); const lock = useRef(false); const pending = useRef(null);
  const composition = selectionActions(ids, cards, visibleIds, { busy });
  // `rebase` (optional) answers a revision conflict once: it returns the same
  // gesture on fresh revisions, or null when it no longer has anything to do.
  async function mutate(mutation, expected = revision, { pendingFavorite = null, rebase = null } = {}) {
    if (lock.current) return false;
    lock.current = true; setBusy(true); setError(null);
    if (pendingFavorite) optimistic?.set(pendingFavorite.ids, pendingFavorite.value);
    const payload = JSON.stringify({ mutation, expected });
    if (pending.current?.payload !== payload) pending.current = { payload, requestKey: crypto.randomUUID() };
    try {
      let applied = mutation;
      let outcome;
      try {
        outcome = await api.mutate({ ...mutation, requestKey: pending.current.requestKey }, expected);
      } catch (error) {
        if (error?.code !== REVISION_CONFLICT || !rebase) throw error;
        let replay;
        try { replay = await rebase(); } catch { throw error; }
        pending.current = null;
        if (replay) {
          applied = replay.mutation;
          outcome = await api.mutate({ ...replay.mutation, requestKey: crypto.randomUUID() }, replay.expected);
        } else outcome = null;
      }
      pending.current = null;
      if (outcome) {
        onOutcome?.(outcome);
        onAnnounce?.({ key: 'catalogue:data.done', params: { count: outcome.affectedCardIds.length } });
      }
      const local = Boolean(outcome && applyLocal?.(applied, outcome));
      if (pendingFavorite) { optimistic?.settle(pendingFavorite.ids, pendingFavorite.value, outcome?.catalogueRevision ?? null); pendingFavorite = null; }
      if (!local) {
        try { await onReload?.(); } catch (error) { onError?.(error); }
      }
      return outcome ?? true;
    } catch (error) {
      setError(error);
      onFailure?.(error);
      onError?.(error);
      if ([REVISION_CONFLICT, 'CATALOG_NAME_DUPLICATE'].includes(error.code)) { pending.current = null; try { await onReload?.(); } catch (reloadError) { onError?.(reloadError); } }
      return false;
    } finally {
      if (pendingFavorite) optimistic?.clear(pendingFavorite.ids, pendingFavorite.value);
      lock.current = false; setBusy(false);
    }
  }
  function favorite(targets = composition.targets) {
    if (!targets.length) return false;
    const ficheIds = targets.map(card => card.id);
    const value = !targets.every(card => card.favorite);
    // A favorite is an explicit value on each card: after a conflict, it is
    // replayed once on the fresh fiche revisions of the cards still to change.
    // One card read per fiche: a large selection is not replayed, it reloads.
    const rebase = api.getCard && ficheIds.length <= MAX_REBASE ? async () => {
      const fresh = await Promise.all(ficheIds.map(id => api.getCard(id)));
      const remaining = ficheIds.filter((id, index) => fresh[index].favorite !== value);
      if (!remaining.length) return null;
      const byId = new Map(ficheIds.map((id, index) => [id, fresh[index]]));
      return { mutation: { kind: 'setFavorite', ficheIds: remaining, value, expectedFicheRevisions: Object.fromEntries(remaining.map(id => [id, byId.get(id).ficheRevision])) },
        expected: fresh[0].catalogueRevision ?? revision };
    } : null;
    return mutate({ kind: 'setFavorite', ficheIds, value, expectedFicheRevisions: Object.fromEntries(targets.map(card => [card.id, card.ficheRevision])) }, revision,
      { pendingFavorite: { ids: ficheIds, value }, rebase });
  }
  return { ...composition, error, busy, mutate, favorite };
}
