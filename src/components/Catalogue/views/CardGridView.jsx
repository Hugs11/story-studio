import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { MemoCatalogueCard } from './CatalogueCard.jsx';
import { DraggableCard } from '../lunii/CatalogueDragSources.jsx';
import { GRID_COLUMNS, CARD_ASPECT_RATIO, cardsPerWindow } from '../../../store/catalogue/windowing.js';

/** Vue Catalogue : grille de cartes, une par fiche, dans l'ordre du pipeline. */
export function CardGridView({ items, view }) {
  const { t } = useCatalogueTranslation();
  const Card = view.luniiSend?.drag ? DraggableCard : MemoCatalogueCard;
  return <div
    role="grid"
    className={view.window ? "catalogue-window-grid" : "catalogue-grid"}
    aria-label={t('catalogue:toolbar.view.cards')}
    aria-multiselectable="true"
    aria-rowcount={items.length}
    ref={view.containerRef}
    style={{ '--catalogue-card-height': view.window ? `${view.window.cardHeight}px` : undefined,
      '--catalogue-card-aspect-ratio': CARD_ASPECT_RATIO,
      '--catalogue-grid-min': `${GRID_COLUMNS.minCardRem}rem`,
      '--catalogue-grid-per-window': cardsPerWindow(view.density),
      '--catalogue-grid-gap': `${GRID_COLUMNS.standaloneGapPx}px`,
      '--catalogue-window-grid-gap': `${GRID_COLUMNS.gapRem}rem` }}
  >
    {view.window ? view.window.segments.map((segment,index) => segment.kind === 'spacer'
      ? <div key={`spacer-${index}`} aria-hidden="true" style={{ height: segment.height }} />
      : <div key={segment.row} role="presentation" className="catalogue-window-grid-row" style={{ height: segment.height, maxWidth: view.window.gridWidth, gridTemplateColumns: `repeat(${view.window.columns}, minmax(0, 1fr))` }}>
        {items.slice(segment.start,segment.end).map((item,offset) => <Card key={item.card.id} item={item} index={segment.start+offset} view={view} />)}
      </div>) : items.map((item, index) => <Card key={item.card.id} item={item} index={index} view={view} />)}
  </div>;
}
