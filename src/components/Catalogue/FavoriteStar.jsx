import { Star } from '../icons/LucideLocal.jsx';
import { Tooltip } from '../common/Tooltip.jsx';
import { useCatalogueTranslation } from '../../i18n/useCatalogueTranslation.js';

/**
 * Étoile de favori en coin de jaquette : bascule au clic, visible au survol de
 * la carte ou si la fiche est favorite (voir `.catalogue-star`). Occupée par
 * une modification : l'action est ignorée, sans phrase d'explication.
 */
export function FavoriteStar({ favorite, busy = false, onChange, tabIndex = 0, label: accessibleLabel, describedBy }) {
  const { t } = useCatalogueTranslation();
  const label = accessibleLabel ?? (favorite ? t('catalogue:data.unfavorite') : t('catalogue:data.favorite'));
  return <Tooltip asChild text={label} placement="below">
    <button type="button" className="catalogue-star" tabIndex={tabIndex} aria-label={label} aria-describedby={describedBy} aria-pressed={!!favorite} aria-disabled={busy || undefined}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); }}
      onClick={(event) => { event.stopPropagation(); if (!busy) onChange?.(); }}>
      <Star width={18} height={18} />
    </button>
  </Tooltip>;
}
