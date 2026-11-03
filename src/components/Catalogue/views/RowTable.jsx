import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { ColumnPicker } from '../ColumnPicker.jsx';
import { MemoCatalogueRow } from './CatalogueRow.jsx';
import { DraggableRow } from '../lunii/CatalogueDragSources.jsx';
import { COLUMN_SORT_KEYS } from '../../../store/catalogue/sort.js';
import { WINDOW_HEIGHTS } from '../../../store/catalogue/windowing.js';

/** Liste à colonnes redimensionnables, sans modifier les hauteurs virtualisées. */
export function RowTable({ items, view, columns, labelKey, className, mode }) {
  const { t } = useCatalogueTranslation();
  const Row = view.luniiSend?.drag ? DraggableRow : MemoCatalogueRow;
  const widths = columns.map(c => view.listColumns?.colWidths[c.id] ?? c.defaultWidth);
  return <div className="catalogue-table-scroll">
    <table role="grid" className={`catalogue-table ${className}`} aria-label={t(labelKey)} aria-multiselectable="true" aria-rowcount={items.length + 1} ref={view.containerRef} style={{ '--catalogue-row-height': `${WINDOW_HEIGHTS[mode]}rem`, width: widths.reduce((a, b) => a + b, 72), minWidth: '100%', tableLayout: 'fixed' }}>
      <colgroup>{columns.map((c, i) => <col key={c.id} style={{ width: widths[i] }} />)}<col style={{ width: 72 }} /></colgroup>
      <thead><tr role="row">
        {columns.map((column) => {
          const sortKey = view.sort && view.setSortKey ? COLUMN_SORT_KEYS[column.id] : undefined;
          const active = sortKey !== undefined && view.sort.key === sortKey;
          const label = t(column.labelKey);
          return <th role="columnheader" scope="col" key={column.id} className={`catalogue-cell--${column.id}`} aria-sort={active ? (view.sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}>
            {sortKey !== undefined
              ? <button type="button" className="catalogue-sort-header" onClick={() => (active ? view.toggleDirection() : view.setSortKey(sortKey))}>{label}{active && <span className="catalogue-sort-indicator" aria-hidden="true">{view.sort.direction === 'asc' ? '▲' : '▼'}</span>}</button>
              : column.id === 'cover' ? <span className="catalogue-visually-hidden">{label}</span> : label}
            {view.listColumns && <span className="me-col-resize" aria-hidden="true" onPointerDown={event => view.listColumns.startResize(event, column.id)} />}</th>;
        })}
        <th role="columnheader" scope="col" className="catalogue-cell--actions"><span className="catalogue-visually-hidden">{t('catalogue:exemplar.column.actions')}</span>{view.listColumns && <ColumnPicker columns={view.listColumns} />}</th>
      </tr></thead>
      <tbody>{view.window ? view.window.segments.map((segment,index) => segment.kind === 'spacer'
        ? <tr key={`spacer-${index}`} aria-hidden="true" role="presentation"><td colSpan={columns.length+1} style={{ height:segment.height, padding:0, border:0 }} /></tr>
        : <Row key={items[segment.start].card.id} item={items[segment.start]} index={segment.start+1} columns={columns} view={view} />)
        : items.map((item, index) => <Row key={item.card.id} item={item} index={index + 1} columns={columns} view={view} />)}</tbody>
    </table>
  </div>;
}
