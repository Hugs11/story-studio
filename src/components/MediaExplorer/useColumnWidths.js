import { KEYS } from '../../store/persistentSettings.js';
import { usePersistentColumns } from '../../hooks/usePersistentColumns.js';

// Clés résolues à l'affichage : la table ne capture aucun libellé au chargement.
export const COLUMNS = [
  { id: 'name',  labelKey: 'media:explorer.column.name',       defaultWidth: 200 },
  { id: 'usage', labelKey: 'media:explorer.column.usage',      defaultWidth: 120 },
  { id: 'size',  labelKey: 'media:explorer.column.size',       defaultWidth: 60  },
  { id: 'dim',   labelKey: 'media:explorer.column.dimensions', defaultWidth: 80  },
  { id: 'dur',   labelKey: 'media:explorer.column.duration',   defaultWidth: 72  },
  { id: 'fmt',   labelKey: 'media:explorer.column.format',     defaultWidth: 100 },
  { id: 'date',  labelKey: 'media:explorer.column.date',       defaultWidth: 110 },
  { id: 'path',  labelKey: 'media:explorer.column.path',       defaultWidth: 260 },
  { id: 'tags',  labelKey: 'media:explorer.column.tags',       defaultWidth: 120 },
];

const OLD_COL_IDS = ['name', 'usage', 'size', 'dim', 'fmt', 'path', 'tags'];
const CONFIG = {
  columns: COLUMNS,
  widthsKey: KEYS.MEDIA_EXPLORER_COL_WIDTHS,
  visibleKey: KEYS.MEDIA_EXPLORER_VISIBLE_COLS,
  legacyIds: OLD_COL_IDS,
};

export function colsToGrid(widths, visibleCols) {
  return `56px ${COLUMNS.filter((c) => visibleCols.has(c.id)).map((c) => `${widths[c.id]}px`).join(' ')} 30px`;
}

export function useColumnWidths(options = {}) {
  return usePersistentColumns(CONFIG, options);
}
