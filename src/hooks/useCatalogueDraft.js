import { useEffect, useReducer, useRef, useState } from 'react';
import { draftReducer, dirtyDraft, draftChanges, validateDraft } from '../store/catalogue/metadataDraft.js';
import { catalogueDataApi, REVISION_CONFLICT } from '../store/catalogue/catalogueDataApi.js';
import { ficheDraftChanges } from '../store/catalogue/ficheEditing.js';
export function useCatalogueDraft(card, reload, api = catalogueDataApi, options = {}) {
  const [draft, dispatch] = useReducer(draftReducer, null);
  const [saving, setSaving] = useState(false); const [error, setError] = useState(null);
  const pending = useRef(null); const busy = useRef(false);
  useEffect(() => { if (card) dispatch({ type: 'load', card }); }, [card]);
  const dirty = dirtyDraft(draft); const errors = validateDraft(draft, options);
  async function save() {
    if (busy.current || !draft || Object.keys(errors).length || Object.keys(draft.conflicts).length) return false;
    const changes = options.singleAge ? ficheDraftChanges(draft) : draftChanges(draft); if (!changes.length) return true;
    busy.current = true; setSaving(true); setError(null);
    const payload = JSON.stringify({ changes, revision: draft.catalogueRevision, fiche: draft.ficheRevision });
    if (pending.current?.payload !== payload) pending.current = { payload, requestKey: crypto.randomUUID() };
    try {
      await api.mutate({ kind: 'setMetadataBatch', ficheId: draft.ficheId, expectedFicheRevision: draft.ficheRevision, changes, requestKey: pending.current.requestKey }, draft.catalogueRevision);
      pending.current = null;
      const fresh = await reload(); dispatch({ type: 'saved', card: fresh }); return true;
    } catch (error) {
      setError(error);
      if (error.code === REVISION_CONFLICT) { pending.current = null; try { const fresh = await reload(); dispatch({ type: 'load', card: fresh }); } catch (error) { setError(error); } }
      return false;
    } finally { busy.current = false; setSaving(false); }
  }
  return { draft, dispatch, dirty, errors, saving, error, save };
}
