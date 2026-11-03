import { LUNII_PANEL_WIDTH } from '../store/catalogue/luniiDevices.js';
import { CATALOGUE_GRID_MIN_WIDTH, FICHE_WIDTH } from './useCatalogueFicheWidth.js';
import { observeResizeDeferred } from './observeResizeDeferred.js';
import { useLayoutEffect, useRef, useState } from 'react';

export function luniiPanelMaxWidth(parentWidth, ficheOpen) {
  return Math.max(LUNII_PANEL_WIDTH.min, parentWidth - CATALOGUE_GRID_MIN_WIDTH - (ficheOpen ? FICHE_WIDTH.min : 0));
}

/** Reserve fiche and grid when possible; ficheWidthBounds lets the grid yield first. */
export function useLuniiPanelWidth(preferred, open, ficheOpen = false) {
  const panelRef = useRef(null);
  const [available, setAvailable] = useState(null);
  useLayoutEffect(() => {
    const parent = panelRef.current?.parentElement;
    if (!open || !parent) return undefined;
    const measure = () => {
      const next = luniiPanelMaxWidth(parent.clientWidth, ficheOpen);
      setAvailable(previous => previous === next ? previous : next);
    };
    measure();
    return observeResizeDeferred([parent], measure);
  }, [open, ficheOpen]);
  return { panelRef, value: Math.max(LUNII_PANEL_WIDTH.min, Math.min(preferred, available ?? preferred)), max: Math.max(LUNII_PANEL_WIDTH.min, available ?? preferred) };
}
