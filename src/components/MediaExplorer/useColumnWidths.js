import { useRef, useState } from 'react';
import { KEYS, read, write } from '../../store/persistentSettings';

export const COLUMNS = [
  { id: 'name',  label: 'Nom',        defaultWidth: 200 },
  { id: 'usage', label: 'Usage',      defaultWidth: 120 },
  { id: 'size',  label: 'Taille',     defaultWidth: 60  },
  { id: 'dim',   label: 'Dimensions', defaultWidth: 80  },
  { id: 'dur',   label: 'Durée',      defaultWidth: 72  },
  { id: 'fmt',   label: 'Format',     defaultWidth: 100 },
  { id: 'date',  label: 'Date',       defaultWidth: 110 },
  { id: 'path',  label: 'Chemin',     defaultWidth: 260 },
  { id: 'tags',  label: 'Tags',       defaultWidth: 120 },
];

export const DEFAULT_COL_WIDTHS = Object.fromEntries(COLUMNS.map((c) => [c.id, c.defaultWidth]));
const OLD_COL_IDS = ['name', 'usage', 'size', 'dim', 'fmt', 'path', 'tags'];

export function loadColWidths() {
  const saved = read(KEYS.MEDIA_EXPLORER_COL_WIDTHS, { parse: JSON.parse });
  if (saved && !Array.isArray(saved)) {
    return { ...DEFAULT_COL_WIDTHS, ...Object.fromEntries(Object.entries(saved).map(([k, v]) => [k, Math.max(40, Number(v))])) };
  }
  if (Array.isArray(saved)) {
    const result = { ...DEFAULT_COL_WIDTHS };
    saved.slice(0, OLD_COL_IDS.length).forEach((w, i) => { result[OLD_COL_IDS[i]] = Math.max(40, Number(w)); });
    return result;
  }
  return { ...DEFAULT_COL_WIDTHS };
}

export function loadVisibleCols() {
  const saved = read(KEYS.MEDIA_EXPLORER_VISIBLE_COLS, { parse: JSON.parse });
  if (Array.isArray(saved)) {
    const valid = new Set(COLUMNS.map((c) => c.id));
    const filtered = saved.filter((id) => valid.has(id));
    if (filtered.length > 0) return new Set(filtered);
  }
  return new Set(COLUMNS.map((c) => c.id));
}

export function colsToGrid(widths, visibleCols) {
  return `56px ${COLUMNS.filter((c) => visibleCols.has(c.id)).map((c) => `${widths[c.id]}px`).join(' ')} 30px`;
}

export function useColumnWidths({ sortCol, onSortColReset } = {}) {
  const [colWidths, setColWidthsState] = useState(loadColWidths);
  const colWidthsRef = useRef(colWidths);
  const [visibleCols, setVisibleColsState] = useState(loadVisibleCols);

  function setColWidths(newWidths) {
    colWidthsRef.current = newWidths;
    setColWidthsState(newWidths);
  }

  function toggleCol(id) {
    setVisibleColsState((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        if (next.size <= 1) return prev;
        next.delete(id);
        if (sortCol === id) onSortColReset?.();
      } else {
        next.add(id);
      }
      write(KEYS.MEDIA_EXPLORER_VISIBLE_COLS, [...next], { serialize: JSON.stringify });
      return next;
    });
  }

  return { colWidths, colWidthsRef, visibleCols, setColWidths, toggleCol };
}
