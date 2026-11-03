import { CATALOGUE_COLUMNS, LIST_COLUMNS } from '../../../store/catalogue/listColumns.js';
import { useMemo } from 'react';
import { RowTable } from './RowTable.jsx';

/** Vue Liste : lignes compactes, mêmes fiches et même ordre que les autres vues. */
export function ListView({ items, view }) {
  // Same array while the visible columns are unchanged: memoized rows compare it by identity.
  const visible = view.listColumns?.visibleCols;
  const columns = useMemo(() => visible ? LIST_COLUMNS.filter(c => visible.has(c.id)) : LIST_COLUMNS.filter(c => CATALOGUE_COLUMNS.defaultVisible.includes(c.id)), [visible]);
  return <RowTable items={items} view={view} columns={columns} labelKey="catalogue:toolbar.view.list" className="catalogue-table--list" mode="list" />;
}
