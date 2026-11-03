import { useEffect, useRef, useState } from 'react';
import { read, write } from '../store/persistentSettings.js';

export function loadColumnWidths({ columns, widthsKey, legacyIds = [] }) {
  const defaults = Object.fromEntries(columns.map(c => [c.id, c.defaultWidth]));
  const saved = read(widthsKey, { parse: JSON.parse });
  if (saved && !Array.isArray(saved)) {
    return { ...defaults, ...Object.fromEntries(Object.entries(saved).map(([k, v]) => [k, Math.max(40, Number(v))])) };
  }
  if (Array.isArray(saved)) {
    saved.slice(0, legacyIds.length).forEach((w, i) => { defaults[legacyIds[i]] = Math.max(40, Number(w)); });
  }
  return defaults;
}

export function loadVisibleColumns({ columns, visibleKey, defaultVisible = columns.map(c => c.id), required = [] }) {
  const saved = read(visibleKey, { parse: JSON.parse });
  if (Array.isArray(saved)) {
    const valid = new Set(columns.map(c => c.id));
    const filtered = saved.filter(id => valid.has(id));
    if (filtered.length > 0) return new Set([...filtered, ...required]);
  }
  return new Set(defaultVisible);
}

/** Preferences and pointer resizing shared by media and catalogue lists. */
export function usePersistentColumns(config, { sortCol, onSortColReset } = {}) {
  const [colWidths, setColWidthsState] = useState(() => loadColumnWidths(config));
  const colWidthsRef = useRef(colWidths);
  const [visibleCols, setVisibleColsState] = useState(() => loadVisibleColumns(config));
  const resizeCleanup = useRef(null);
  useEffect(() => () => resizeCleanup.current?.(), []);

  function setColWidths(newWidths) {
    colWidthsRef.current = newWidths;
    setColWidthsState(newWidths);
  }

  function toggleCol(id) {
    if (config.required?.includes(id)) return;
    setVisibleColsState(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        if (next.size <= 1) return prev;
        next.delete(id);
        if (sortCol === id) onSortColReset?.();
      } else {
        next.add(id);
      }
      write(config.visibleKey, [...next], { serialize: JSON.stringify });
      return next;
    });
  }

  function startResize(event, colId) {
    event.preventDefault();
    resizeCleanup.current?.();
    const startX = event.clientX;
    const startWidth = colWidthsRef.current[colId];
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = 'col-resize';
    function onMove(ev) {
      setColWidths({ ...colWidthsRef.current, [colId]: Math.max(40, startWidth + ev.clientX - startX) });
    }
    function cleanup() {
      document.body.style.cursor = previousCursor;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      resizeCleanup.current = null;
    }
    function onUp() {
      cleanup();
      write(config.widthsKey, colWidthsRef.current, { serialize: JSON.stringify });
    }
    resizeCleanup.current = cleanup;
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }

  function resetColumns() {
    const widths = Object.fromEntries(config.columns.map(c => [c.id, c.defaultWidth]));
    setColWidths(widths);
    setVisibleColsState(new Set(config.defaultVisible ?? config.columns.map(c => c.id)));
    write(config.widthsKey, widths, { serialize: JSON.stringify });
    write(config.visibleKey, config.defaultVisible ?? config.columns.map(c => c.id), { serialize: JSON.stringify });
  }
  return { resetColumns, colWidths, colWidthsRef, visibleCols, setColWidths, toggleCol, startResize };
}
