import { createCheckerPreparationLifetime } from '../../../store/catalogue/checkerPreparation.js';
import { useEffect, useRef, useState } from 'react';
import { catalogueFilesApi } from '../../../store/catalogue/catalogueFilesApi.js';
import { catalogueDataApi } from '../../../store/catalogue/catalogueDataApi.js';
import { checkerAvailability } from '../../../store/catalogue/duplicateModel.js';
import { presentCatalogueError } from '../../../store/catalogue/catalogueApi.js';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { CommunityPackCheckerFunnel } from '../../CommunityPackChecker/CommunityPackCheckerFunnel.jsx';
import { CatalogueDataDialog } from '../CatalogueDataDialog.jsx';
// Preparation is owned by the existing checker once mounted. A late result
// after the chooser closes is released without ever mounting another funnel.
export function CheckerEntry({ card, exemplar = null, onClose }) {
  const { t } = useCatalogueTranslation(); const [entry, setEntry] = useState(null); const [error, setError] = useState(null); const [busy, setBusy] = useState(false);
  const releaseOwner = useRef(null);
  const mounted = useRef(false); const lock = useRef(false); const started = useRef(false);
  async function prepare(selected) {
    if (lock.current || !checkerAvailability(selected).enabled) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      const fresh = await catalogueDataApi.getCard(card.ficheId ?? card.id);
      const prepared = await catalogueFilesApi.prepareChecker(selected.id, fresh.catalogueRevision);
      if (mounted.current) {
        const lifetime = createCheckerPreparationLifetime(() => catalogueFilesApi.releaseChecker(prepared.preparationId), cause => { if (mounted.current) setError(cause); });
        releaseOwner.current = lifetime.retain();
        setEntry({ prepared, lifetime });
      }
      else await catalogueFilesApi.releaseChecker(prepared.preparationId);
    } catch (cause) { if (mounted.current) setError(cause); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; releaseOwner.current?.(); }; }, []);
  useEffect(() => { if (exemplar && !started.current) { started.current = true; void prepare(exemplar); } });
  if (entry) return <CommunityPackCheckerFunnel key={entry.prepared.preparationId} initialEntry={entry.prepared} preparationLifetime={entry.lifetime} onClose={onClose} />;
  return <CatalogueDataDialog label={t('catalogue:diagnostics.checker')} onClose={onClose}>
    <h3>{t('catalogue:diagnostics.checker')}</h3>
    {busy && <p role="status">{t('catalogue:diagnostics.preparing')}</p>}
    {error && <p role="alert">{presentCatalogueError(error).message}</p>}
    <ul>{(exemplar ? [exemplar] : card.exemplars ?? []).map(item => {
      const available = checkerAvailability(item); const reasonId = `checker-unavailable-${item.id}`;
      return <li key={item.id}><button type="button" aria-disabled={busy || !available.enabled} aria-describedby={!available.enabled ? reasonId : undefined} onClick={() => { if (!busy && available.enabled) void prepare(item); }}><span className="catalogue-path">{item.path ?? item.fileName}</span>{item.member && <span className="catalogue-path">{item.member}</span>}</button>{!available.enabled && <p id={reasonId}>{t('catalogue:diagnostics.checkerUnavailable')}</p>}</li>;
    })}</ul>
    <button type="button" onClick={onClose}>{t('catalogue:data.close')}</button>
  </CatalogueDataDialog>;
}
