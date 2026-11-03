import { useEffect, useState } from 'react';
import { catalogueFilesApi } from '../store/catalogue/catalogueFilesApi.js';

/** This owner cancels disk work when the fiche closes or its exemplars change. */
export function useCatalogueIdenticalCopies(card, api = catalogueFilesApi) {
  const [result, setResult] = useState(null);
  const signature = JSON.stringify([card.id, card.exemplars]);
  useEffect(() => {
    let alive = true;
    // A settled request has nothing left to stop: cancelling it would only
    // leave a tombstone behind in the engine.
    let settled = false;
    const requestId = crypto.randomUUID();
    void api.identicalCopies(card.id, requestId).then(ids => {
      settled = true;
      if (alive) setResult({ signature, ids });
    }, () => { settled = true; });
    return () => {
      alive = false;
      if (!settled) void api.cancelIdenticalCopies(requestId).catch(() => {});
    };
  }, [card.id, signature, api]);
  return result?.signature === signature ? result.ids : [];
}
