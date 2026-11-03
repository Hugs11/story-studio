import { useRef, useState } from 'react';
import { useCatalogueCover } from '../../../hooks/useCatalogueCover.js';
import { catalogueDataApi } from '../../../store/catalogue/catalogueDataApi.js';
import { presentCatalogueError } from '../../../store/catalogue/catalogueApi.js';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { Button } from '../../common/Button.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';
import { Pencil } from '../../icons/LucideLocal.jsx';

/**
 * Same discreet pencil as the other fiche fields: it chooses a new image,
 * catalogue only. The pack's own cover stays kept by the engine beneath the
 * correction; the fiche offers no reset.
 */
export function CoverPencil({ reload, onBeforeAction, idPrefix = 'catalogue-fiche' }) {
  const { t } = useCatalogueTranslation();
  const cover = useCatalogueCover();
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const trigger = useRef(null);
  const choose = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      if (onBeforeAction && !await onBeforeAction()) return;
      const image = await cover.choose();
      if (!image) return;
      const fresh = await reload();
      await catalogueDataApi.mutate({ kind: 'setMetadataBatch', ficheId: fresh.ficheId, expectedFicheRevision: fresh.ficheRevision, requestKey: crypto.randomUUID(), changes: [{ field: 'cover', state: 'defined', coverStagingId: image.coverStagingId }] }, fresh.catalogueRevision);
      await reload();
    } catch (cause) { setError(cause); }
    finally { pending.current = false; setBusy(false); trigger.current?.focus(); }
  };
  const label = t('catalogue:fiche.inline.editField', { field: t('catalogue:fiche.edit.field.cover') });
  return <>
    <div className="catalogue-fiche-cover-actions" data-active={busy || undefined}>
      <Tooltip text={label} asChild wrap><Button ref={trigger} id={`${idPrefix}-pencil-cover`} className="catalogue-fiche-cover-action" variant="icon" size="sm" disabled={busy} aria-label={label} onClick={choose}><Pencil width={16} height={16} /></Button></Tooltip>
    </div>
    {(error ?? cover.error) && <p role="alert">{presentCatalogueError(error ?? cover.error).message}</p>}
  </>;
}
