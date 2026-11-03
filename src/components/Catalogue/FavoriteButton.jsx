import { useId } from 'react';
import { useCatalogueTranslation } from '../../i18n/useCatalogueTranslation.js';
export function FavoriteButton({ favorite, busy = false, onChange, tabIndex = 0 }) {
  const { t } = useCatalogueTranslation(); const reasonId = useId();
  return <button type="button" tabIndex={tabIndex} aria-pressed={!!favorite} aria-disabled={busy || undefined} aria-describedby={busy ? reasonId : undefined}
    onDoubleClick={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); if (!busy) onChange?.(); }}>
    <span aria-hidden="true">{favorite ? '★' : '☆'}</span> {t(favorite ? 'catalogue:data.unfavorite' : 'catalogue:data.favorite')}
    {busy && <span id={reasonId}>{t('catalogue:data.busy')}</span>}
  </button>;
}
