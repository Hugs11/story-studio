import { useEffect, useRef, useState } from 'react';
import { observeResizeDeferred } from './observeResizeDeferred.js';
import { KEYS, read, write } from '../store/persistentSettings.js';

// The grid yields before either side panel reaches its minimum.
export const CATALOGUE_GRID_MIN_WIDTH = 360;
export const FICHE_WIDTH = { min: 320, max: 720, initial: 420 };
export function boundedFicheWidth(value) {
  return Math.max(FICHE_WIDTH.min, Math.min(FICHE_WIDTH.max, Number(value) || FICHE_WIDTH.initial));
}

/** Desktop reserves the catalogue column; the narrow layout overlays it. */
export function ficheWidthBounds(parentWidth, viewportWidth, reservedWidth = 0) {
  const available = parentWidth > 0 ? Math.max(0, parentWidth - reservedWidth) : FICHE_WIDTH.max;
  const gridReserve = viewportWidth > 900
    ? Math.min(CATALOGUE_GRID_MIN_WIDTH, Math.max(0, available - FICHE_WIDTH.min)) : 0;
  // Only when both panels alone no longer fit does the fiche yield as well.
  const max = Math.min(FICHE_WIDTH.max, available - gridReserve);
  return { min: Math.min(FICHE_WIDTH.min, max), max };
}

/** Window resizing constrains the display without overwriting the user's preference. */
export function useCatalogueFicheWidth(open, onWidthChange, reservedWidth = 0) {
  const panelRef = useRef(null);
  const [preferred, setPreferred] = useState(() => boundedFicheWidth(read(KEYS.CATALOGUE_FICHE_WIDTH)));
  const [bounds, setBounds] = useState({ min: FICHE_WIDTH.min, max: FICHE_WIDTH.max });
  useEffect(() => {
    if (!open) return undefined;
    const parent = panelRef.current?.parentElement;
    if (!parent) return undefined;
    const measure = () => {
      const next = ficheWidthBounds(parent.getBoundingClientRect().width, window.innerWidth, reservedWidth);
      setBounds(previous => previous.min === next.min && previous.max === next.max ? previous : next);
    };
    measure();
    const stop = observeResizeDeferred([parent], measure);
    window.addEventListener('resize', measure);
    return () => { stop(); window.removeEventListener('resize', measure); };
  }, [open, reservedWidth]);
  const value = Math.max(bounds.min, Math.min(bounds.max, preferred));
  return { panelRef, ...bounds, value, onResize(nextWidth) {
    const next = Math.max(bounds.min, Math.min(bounds.max, Number(nextWidth) || FICHE_WIDTH.initial));
    setPreferred(next);
    write(KEYS.CATALOGUE_FICHE_WIDTH, String(next));
    onWidthChange?.(next);
  } };
}
