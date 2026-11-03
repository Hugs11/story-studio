import { MissingValue } from '../MissingValue.jsx';
import { SearchExplanation } from './SearchExplanation.jsx';
import { CardTags } from '../tags/CardTags.jsx';
import { Fragment, memo } from 'react';
import { sameCardProps } from '../../../store/catalogue/cardRenderMemo.js';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { languageLabel } from '../../../store/catalogue/languageOptions.js';
import { detailsRow } from '../../../store/catalogue/detailsRow.js';
import { formatTags } from '../../../store/catalogue/formatTag.js';
import { domId } from '../../../store/catalogue/viewModes.js';
import { FormatTagRow } from '../FormatTag.jsx';
import { FavoriteStar } from '../FavoriteStar.jsx';
import { CardCover } from './CardCover.jsx';
import { OfflineBadge } from './OfflineBadge.jsx';
import { OfficialBadge } from './OfficialBadge.jsx';
import { ExemplarTable } from './ExemplarTable.jsx';
import { ChevronDown, ChevronRight } from '../../icons/LucideLocal.jsx';
import { ageFilterLabel } from '../../../store/catalogue/ageFilter.js';
import { Tooltip } from '../../common/Tooltip.jsx';

/**
 * Ligne d'une fiche pour les vues Liste et Détails : colonnes choisies par la
 * vue, étiquettes cliquables, flèche qui déplie le tableau des exemplaires
 * sous la ligne. Favori : étoile sur la jaquette ; « Modifier » : menu clic droit.
 */
export function CatalogueRow({ item, index, columns, view, dragSource }) {
  const { t, cell, line } = useCatalogueTranslation();
  const { card, exemplars, representative } = item;
  const row = detailsRow(card, representative);
  const itemId = domId('catalogue-item', card.id);
  const tableId = domId('catalogue-exemplars', card.id);
  const active = view.activeId === card.id;
  const expanded = view.expanded.has(card.id);
  const focusable = active ? 0 : -1;
  const title = (card.displayTitle ?? card.title) ?? t('catalogue:card.untitled');
  const hasCover = columns.some((column) => column.id === 'cover');
  const content = (column) => {
    switch (column.id) {
      case 'cover': return <CardCover card={card} size="small" view={view} star={false} />;
      case 'title': return <>{!hasCover && <OfflineBadge card={card} />}<span className={row.titleMissing ? 'catalogue-missing' : undefined}>{title}</span><OfficialBadge card={card} /><SearchExplanation item={item} /></>;
      case 'age': return row.age.kind === 'missing' ? <MissingValue /> : <Tooltip text={line(ageFilterLabel({ min: card.age.min, max: card.age.min }, { summary: true }))} asChild wrap><button type="button" className="catalogue-filter-badge" tabIndex={focusable}
        onClick={event => { event.stopPropagation(); if (event.detail <= 1) view.onFilterAge?.(card.age.min); }}
        onDoubleClick={event => event.stopPropagation()}
        onKeyDown={event => { if (['Enter', ' '].includes(event.key)) event.stopPropagation(); }}>{cell(row.age)}</button></Tooltip>;
      case 'tags': return <CardTags tags={card.tags} onFilter={view.onFilterTag} />;
      case 'summary': return <span className="catalogue-summary">{cell(row.summary)}</span>;
      case 'formats': return <FormatTagRow tags={formatTags(exemplars)} idPrefix={domId('catalogue-tag', card.id)} tabIndex={focusable} compact onActivate={(tag, event) => view.onFormatClick(event, item.card.id, tag.format)} onMenuKey={event => view.onCardMenu(event, item)} />;
      case 'language': { const name = row.language.kind === 'text' ? languageLabel(row.language.value, t) : cell(row.language); return <Tooltip text={name} asChild wrap whenTruncated disabled={row.language.kind === 'missing'}><span className="catalogue-cell-text">{row.language.kind === 'missing' ? <MissingValue /> : name}</span></Tooltip>; }
      default: return <Tooltip text={cell(row[column.id])} asChild wrap whenTruncated disabled={row[column.id]?.kind === 'missing'}><span className="catalogue-cell-text">{row[column.id]?.kind === 'missing' ? <MissingValue /> : cell(row[column.id])}</span></Tooltip>;
    }
  };
  return <Fragment>
    <tr
      role="row"
      id={itemId}
      aria-rowindex={index + 1}
      aria-selected={view.selected.has(card.id)}
      tabIndex={focusable}
      ref={dragSource?.ref}
      onPointerDown={dragSource?.onPointerDown}
      className={`catalogue-row${view.luniiSend?.drag?.dragIds?.has(card.id) ? ' is-dragging' : ''}${view.selected.has(card.id) ? ' catalogue-row--selected' : ''}${card.available ? '' : ' catalogue-row--unavailable'}`}
      data-card-id={card.id}
      onClick={(event) => view.onItemClick(event, card.id)}
      onContextMenu={(event) => view.onCardMenu(event, item)}
      onKeyDown={(event) => view.onItemKeyDown(event, item)}
      onFocus={(event) => { if (event.target === event.currentTarget) view.setActiveId(card.id); }}
    >
      {columns.map((column) => <td role="gridcell" key={column.id} className={`catalogue-cell catalogue-cell--${column.id}`}><div className="catalogue-cell-content">{content(column)}</div></td>)}
      <td role="gridcell" className="catalogue-cell catalogue-cell--actions"><div className="catalogue-cell-content">
        <button
          type="button"
          className="catalogue-expand"
          tabIndex={focusable}
          aria-expanded={expanded}
          aria-controls={expanded ? tableId : undefined}
          aria-label={t('catalogue:row.exemplars.toggle', { title, count: exemplars.length })}
          onClick={(event) => { event.stopPropagation(); view.onToggleExpanded(card.id); }}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); }}
        >{expanded ? <ChevronDown width={16} height={16} /> : <ChevronRight width={16} height={16} />}</button>
        <FavoriteStar favorite={card.favorite} busy={view.dataBusy} tabIndex={focusable} onChange={() => view.onFavorite?.(card)} />
      </div></td>
    </tr>
    {expanded && <tr className="catalogue-exemplars-row" id={tableId} data-focus-card-id={card.id}>
      <td colSpan={columns.length + 1}>
        <div className="catalogue-window-exemplars"><ExemplarTable card={card} exemplars={exemplars} idPrefix={domId('catalogue-row', card.id)} /></div>
      </td>
    </tr>}
  </Fragment>;
}

/** Row skipped while its own item and state are unchanged (see cardRenderMemo.js). */
export const MemoCatalogueRow = memo(CatalogueRow, sameCardProps);
