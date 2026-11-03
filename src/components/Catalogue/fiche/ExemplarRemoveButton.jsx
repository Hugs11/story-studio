import { useState } from 'react';
import { useErrorDialog } from '../../common/Dialog.jsx';
import { Button } from '../../common/Button.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';
import { X } from '../../icons/LucideLocal.jsx';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { catalogueDataApi } from '../../../store/catalogue/catalogueDataApi.js';
import { presentCatalogueError } from '../../../store/catalogue/catalogueApi.js';
import { removeMissingExemplar } from '../../../store/catalogue/removeMissingExemplar.js';

export function ExemplarRemoveButton({ card, exemplar, onDone, onBusy, idPrefix = 'catalogue-fiche' }) {
  const { t } = useCatalogueTranslation();
  const { showChoiceDialog } = useErrorDialog();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function remove() {
    if (busy) return;
    setBusy(true); setError(null); onBusy?.(true);
    try {
      if (await removeMissingExemplar({ card, exemplar, api: catalogueDataApi, showChoiceDialog, t })) onDone?.();
    } catch (reason) { setError(reason); }
    finally { setBusy(false); onBusy?.(false); }
  }
  return <>
    {error && <span role="alert">{presentCatalogueError(error).message}</span>}
    <Tooltip text={t('catalogue:actions.removeFromCatalogue.label')} asChild wrap>
      <Button id={`${idPrefix}-copy-${exemplar.id}-remove`} variant="icon" size="sm" disabled={busy}
        aria-label={t('catalogue:actions.removeFromCatalogue.label')} onClick={event => { event.stopPropagation(); void remove(); }}><X width={16} height={16} /></Button>
    </Tooltip>
  </>;
}
