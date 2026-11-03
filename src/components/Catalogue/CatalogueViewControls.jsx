import { useCatalogueTranslation } from '../../i18n/useCatalogueTranslation.js';
import { VIEW_MODES } from '../../store/catalogue/viewModes.js';
import { Tooltip } from '../common/Tooltip.jsx';
import { Grid2X2, List, PanelRight } from '../icons/LucideLocal.jsx';
import '../layout/Toolbar.css';

const ICONS = { cards: Grid2X2, list: List };

export function CatalogueViewControls({ view }) {
  const { t } = useCatalogueTranslation();
  const panelLabel = view.fichePanelVisible !== false ? t('catalogue:toolbar.panel.hide') : t('catalogue:toolbar.panel.show');
  return <><div className="chrome-panel-pill catalogue-view-group">
    <div className="catalogue-view-modes" role="group" aria-label={t('catalogue:toolbar.view.label')}>
      {VIEW_MODES.map(mode => {
        const Icon = ICONS[mode.id];
        return <Tooltip key={mode.id} text={t(mode.labelKey)}><button type="button" className={`chrome-panel-toggle${view.view === mode.id ? ' is-active' : ''}`} aria-label={t(mode.labelKey)} aria-pressed={view.view === mode.id} onClick={() => view.setView(mode.id)}><Icon className="chrome-icon" /></button></Tooltip>;
      })}
    </div>
    <span className="catalogue-view-separator" aria-hidden="true" />
    <Tooltip text={panelLabel}><button type="button" className={`chrome-panel-toggle catalogue-view-panel-toggle${view.fichePanelVisible !== false ? ' is-active' : ''}`} aria-label={panelLabel} aria-pressed={view.fichePanelVisible !== false} onClick={view.toggleFichePanel}><PanelRight className="chrome-icon" /></button></Tooltip>
  </div>
  </>;
}
