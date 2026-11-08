import { LuniiIcon } from '../../icons/LuniiIcon.jsx';
import { memo } from 'react';
import { CardTagIndicator } from '../tags/CardTagIndicator.jsx';
import { sameCardProps } from '../../../store/catalogue/cardRenderMemo.js';
import { SearchExplanation } from './SearchExplanation.jsx';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { latestExemplarDuration } from '../../../store/catalogue/ficheSummary.js';
import { ageCell } from '../../../store/catalogue/detailsRow.js';
import { formatTags } from '../../../store/catalogue/formatTag.js';
import { cardTitle } from '../../../store/catalogue/entryModel.js';
import { domId } from '../../../store/catalogue/viewModes.js';
import { CardFormatTags } from './CardFormatTags.jsx';
import { CardCover } from './CardCover.jsx';
import { OfficialBadge } from './OfficialBadge.jsx';
import { FavoriteStar } from '../FavoriteStar.jsx';
import { Button } from '../../common/Button.jsx';
import { Play, FilePen } from '../../icons/LucideLocal.jsx';
import { LuniiSendButton } from '../lunii/LuniiSendButton.jsx';
import { simulateCommand, editButton } from '../../../store/catalogue/cardActions.js';
import { ageFilterLabel } from '../../../store/catalogue/ageFilter.js';
import { Tooltip } from '../../common/Tooltip.jsx';

/**
 * Carte compacte : étiquettes et favori en haut, titre et méta/actions
 * superposés en bas sous un dégradé fixe.
 * Clic simple : sélection et fiche ; double-clic (second clic, voir cardActivation) : grande fiche ; clic droit,
 * étiquette comprise : menu de la carte (dont « Modifier »).
 */
export function CatalogueCard({ item, index, view, dragSource }) {
  const { t, cell, line } = useCatalogueTranslation();
  const { card, exemplars } = item;
  const itemId = domId('catalogue-item', card.id);
  const active = view.activeId === card.id;
  const age = ageCell(card.age);
  const simulation = simulateCommand(card, exemplars);
  const edit = editButton(card, card.exemplars);
  const duration = latestExemplarDuration(card);
  return <div
    role="row"
    id={itemId}
    aria-rowindex={index + 1}
    aria-selected={view.selected.has(card.id)}
    tabIndex={active ? 0 : -1}
    ref={dragSource?.ref}
    onPointerDown={dragSource?.onPointerDown}
    className={`catalogue-card${view.luniiSend?.drag?.dragIds?.has(card.id) ? ' is-dragging' : ''}${view.selected.has(card.id) ? ' catalogue-card--selected' : ''}${card.available ? '' : ' catalogue-card--unavailable'}`}
    data-card-id={card.id}
    onClick={(event) => view.onItemClick(event, card.id)}
    onContextMenu={(event) => view.onCardMenu(event, item)}
    onKeyDown={(event) => view.onItemKeyDown(event, item)}
    onFocus={(event) => { if (event.target === event.currentTarget) view.setActiveId(card.id); }}
  >
    <div role="gridcell" className="catalogue-card-cell">
      <div className="catalogue-card-visual">
        <CardCover card={card} view={view} star={false} />
        <div className="catalogue-card-topline"><OfficialBadge card={card} /><CardTagIndicator tags={card.tags} onFilter={view.onFilterTag} tabIndex={active ? 0 : -1} /></div>
        {view.luniiFicheIds?.has(card.id) && <Tooltip text={t('catalogue:lunii.already')} asChild wrap><span className="catalogue-card-lunii" role="img" aria-label={t('catalogue:lunii.already')}><LuniiIcon width={14} height={14} /></span></Tooltip>}
        <FavoriteStar favorite={card.favorite} busy={view.dataBusy} tabIndex={active ? 0 : -1} onChange={() => view.onFavorite?.(card)} />
        <div className="catalogue-card-info">
          <h3 className="catalogue-card-title">{cardTitle(card) ?? t('catalogue:card.untitled')}</h3>
          <SearchExplanation item={item} />
          <div className="catalogue-card-meta">
            <div className="catalogue-card-details">
              {age.kind !== 'missing' && <Tooltip text={line(ageFilterLabel({ min: card.age.min, max: card.age.min }, { summary: true }))} asChild wrap><button type="button" className="catalogue-card-age" tabIndex={active ? 0 : -1}
                onClick={event => { event.stopPropagation(); if (event.detail <= 1) view.onFilterAge?.(card.age.min); }}
                onDoubleClick={event => event.stopPropagation()}
                onKeyDown={event => { if (['Enter', ' '].includes(event.key)) event.stopPropagation(); }}>{cell(age)}</button></Tooltip>}
              {age.kind !== 'missing' && duration.kind !== 'missing' && <span className="catalogue-card-duration" aria-hidden="true"> · </span>}
              {duration.kind !== 'missing' && <span className="catalogue-card-duration">{cell(duration)}</span>}
            </div>
            <div className="catalogue-card-actions">
              {simulation.enabled && <Button variant="primary-violet" size="sm" className="catalogue-card-simulate"
                tabIndex={active ? 0 : -1} aria-haspopup={simulation.choice ? 'dialog' : undefined}
                onClick={event => {
                  // Every click is isolated, including the second one remembered by cardActivation.
                  event.stopPropagation();
                  if (event.detail <= 1) void view.onSimulate(card.id);
                }}
                onDoubleClick={event => event.stopPropagation()}
                onKeyDown={event => { if (['Enter', ' '].includes(event.key)) event.stopPropagation(); }}>
                <Play width={12} height={12} />{t('catalogue:actions.simulate.label')}
              </Button>}
              {edit.enabled && <Tooltip text={t('catalogue:fiche.panel.openEditor')} asChild wrap><Button size="sm" className="catalogue-card-edit" tabIndex={active ? 0 : -1}
                aria-label={t('catalogue:fiche.panel.openEditor')}
                aria-haspopup={edit.choice ? 'dialog' : undefined}
                onClick={event => { event.stopPropagation(); if (event.detail <= 1) void view.onEdit(card.id, event.currentTarget); }}
                onDoubleClick={event => event.stopPropagation()}
                onKeyDown={event => { if (['Enter', ' '].includes(event.key)) event.stopPropagation(); }}><FilePen width={13} height={13} /></Button></Tooltip>}
              {view.luniiSend && <LuniiSendButton state={view.luniiSend.stateOf(card)} tabIndex={active ? 0 : -1} onSend={deviceId => view.luniiSend.onSend(card.id, deviceId)} />}
            </div>
            <CardFormatTags tags={formatTags(exemplars)} idPrefix={domId('catalogue-tag', card.id)} tabIndex={active ? 0 : -1} compact onActivate={(tag, event) => view.onFormatClick(event, item.card.id, tag.format)} onMenuKey={event => view.onCardMenu(event, item)} />
          </div>
        </div>
      </div>
    </div>
  </div>;
}

/** Card skipped while its own item and state are unchanged (see cardRenderMemo.js). */
export const MemoCatalogueCard = memo(CatalogueCard, sameCardProps);
