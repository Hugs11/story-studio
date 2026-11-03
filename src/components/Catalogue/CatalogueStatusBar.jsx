import { useCatalogueTranslation } from '../../i18n/useCatalogueTranslation.js';
import { CARD_DENSITIES, normalizeCardDensity } from '../../store/catalogue/windowing.js';
import { Tooltip } from '../common/Tooltip.jsx';
import { Grid2X2 } from '../icons/LucideLocal.jsx';

/**
 * Barre d'état du Catalogue, la même que celle de l'éditeur (`.bottombar`) :
 * à gauche le nombre de packs affichés, les filtres actifs, à
 * droite la densité des vignettes et la version de l'application.
 */
export function CatalogueStatusBar({ view, cards = [], appVersion = '' }) {
  const { t } = useCatalogueTranslation();
  const density = CARD_DENSITIES.findIndex(level => level.id === normalizeCardDensity(view.density));
  const name = [t('catalogue:toolbar.density.compact'), t('catalogue:toolbar.density.normal'), t('catalogue:toolbar.density.large')][density];
  const disabled = view.view !== 'cards';
  return <footer className="bottombar catalogue-statusbar">
    <span className="status-text catalogue-status-text">
      <span className="catalogue-count">{view.filtered ? t('catalogue:filters.count', { count: view.result.counts.fiches, total: view.total ?? cards.length }) : t('catalogue:status.entries', { fiches: view.result.counts.fiches, exemplaires: view.result.counts.exemplaires })}</span>
    </span>
    <Tooltip text={disabled ? t('catalogue:toolbar.density.gridOnly') : name} placement="above">
      <div className={`catalogue-density${disabled ? ' is-disabled' : ''}`}>
        <Grid2X2 width={12} height={12} aria-hidden="true" />
        <div className="catalogue-density-track">
          <input id="catalogue-card-density" type="range" min="0" max="2" step="1" value={density}
            disabled={disabled} aria-label={t('catalogue:toolbar.density.label')} aria-valuetext={name}
            onChange={event => { if (!disabled) view.setDensity(CARD_DENSITIES[Number(event.target.value)].id); }} />
          <span className="catalogue-density-ticks" aria-hidden="true"><i /><i /><i /></span>
        </div>
        <Grid2X2 width={20} height={20} aria-hidden="true" />
      </div>
    </Tooltip>
    {appVersion && <span className="bottombar-version">v{appVersion}</span>}
  </footer>;
}
