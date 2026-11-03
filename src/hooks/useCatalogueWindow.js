import { browseSession, restoreScroll } from '../store/catalogue/browseSession.js';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { catalogueWindow, sameWindowRows, scrollToIndex, windowLayout, gridColumnCount, gridCardHeight, GRID_COLUMNS, WINDOW_HEIGHTS, WINDOW_MARGIN, windowAnchor, restoreWindowAnchor } from '../store/catalogue/windowing.js';
// The screen scroll area owns scrolling; standalone views (including the benchmark) keep
// their own viewport. Translate screen coordinates to the start of the grid.
function viewport(node) {
  const scroller = node.closest?.('.catalogue-scroll') ?? node;
  const offset = scroller === node ? 0 : node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientTop + scroller.scrollTop;
  return { scroller, offset, top: scroller.scrollTop - offset };
}
export function useCatalogueWindow(items, mode, activeId, expanded, keyboardMove, focusedId = null, scrollPositions = null, density = 'normal') {
  const viewportRef = useRef(null);
  const scroll = useRef(new Map(Object.entries(browseSession.restore()?.scroll ?? {})));
  const previous = useRef(null);
  // `metrics.top` only changes when the rendered rows change; `top` keeps the exact position.
  const [metrics, setMetrics] = useState({ top: 0, height: 720, width: 1024, windowWidth: 1024, rem: 16 });
  const top = useRef(0);
  const currentLayout = useRef(null);
  const ids = useMemo(() => items.map(item => item.card.id), [items]);
  const columns = mode === 'cards' ? gridColumnCount({ ...metrics, density }) : 1;
  const cardHeight = gridCardHeight({ ...metrics, columns });
  const rowHeight = mode === 'cards' ? cardHeight : WINDOW_HEIGHTS[mode] * metrics.rem;
  const layout = useMemo(() => windowLayout({ count: items.length, columns, rowHeight,
    gap: mode === 'cards' ? GRID_COLUMNS.gapRem * metrics.rem : 0, expanded: mode === 'cards' ? [] : ids.map((id,index)=>expanded.has(id)?index:-1).filter(index=>index>=0), expansionHeight: 15*metrics.rem }), [items.length, columns, rowHeight, mode, metrics.rem, expanded, ids]);
  currentLayout.current = layout;
  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const { scroller } = viewport(node);
    scroller.scrollTop = restoreScroll({ scroll: Object.fromEntries(scroll.current) }, mode, Math.max(0,scroller.scrollHeight-scroller.clientHeight));
    let frame;
    const measure = () => {
      cancelAnimationFrame(frame);
      if (scrollPositions) scrollPositions.current[mode] = scroller.scrollTop;
      frame = requestAnimationFrame(() => {
        top.current = viewport(node).top;
        setMetrics(old => {
          const next = { top: top.current, height: scroller.clientHeight, width: node.clientWidth, windowWidth: node.ownerDocument.documentElement.clientWidth, rem: Number.parseFloat(getComputedStyle(node.ownerDocument.documentElement).fontSize) };
          const sameBox = old.height === next.height && old.width === next.width && old.windowWidth === next.windowWidth && old.rem === next.rem;
          return sameBox && (old.top === next.top || sameWindowRows(currentLayout.current, old.top, next.top, next.height)) ? old : next;
        });
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    observer.observe(node.ownerDocument.documentElement); // window width: resizing the window alone moves the column count
    if (scroller !== node) { observer.observe(scroller); observer.observe(node.parentElement); }
    scroller.addEventListener('scroll',measure,{ passive:true }); measure();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); scroller.removeEventListener('scroll',measure); scroll.current.set(mode,scroller.scrollTop); };
  }, [items.length > 0, mode, scrollPositions]);
  // Synchronous catch-up, before paint, after every commit of the host (a side panel opening or closing re-renders it):
  // if the grid width moved, recompute columns now instead of one rAF + render later. It only reads two widths and sets
  // state when they differ, so it cannot loop (the rAF/ResizeObserver path above stays the only observer).
  useLayoutEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const width = node.clientWidth, windowWidth = node.ownerDocument.documentElement.clientWidth;
    if (width !== metrics.width || windowWidth !== metrics.windowWidth) setMetrics(old => old.width === width && old.windowWidth === windowWidth ? old : { ...old, width, windowWidth });
  });
  useLayoutEffect(() => {
    const node = viewportRef.current;
    const old = previous.current;
    if (node && old && old.mode === mode && !keyboardMove.current) {
      const { scroller, offset, top } = viewport(node);
      if (top >= 0) {
        const anchor = windowAnchor(old.layout,old.ids,top);
        scroller.scrollTop = offset + restoreWindowAnchor(layout,ids,anchor,top);
      }
    }
    previous.current = { layout,ids,mode };
  }, [layout, ids, mode, keyboardMove]);
  useEffect(() => {
    if (!keyboardMove.current || !viewportRef.current) return;
    const node = viewportRef.current;
    const { scroller, offset, top } = viewport(node);
    scroller.scrollTop = offset + scrollToIndex(layout,ids.indexOf(activeId),top,scroller.clientHeight);
  }, [activeId, layout, ids, keyboardMove]);
  // reason: metrics.top triggers the update; top.current is the exact position.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const window = useMemo(() => catalogueWindow(layout,{ scrollTop:top.current, viewport:metrics.height, margin:WINDOW_MARGIN, pinned:[ids.indexOf(activeId), ids.indexOf(focusedId)] }),[layout,metrics.top,metrics.height,ids,activeId,focusedId]);
  // `gridWidth` is the width `columns` was computed for; rows are capped to it so a stale count never stretches the cards.
  return { ...window, columns, cardHeight, pageRows: mode === 'cards' ? Math.max(1, Math.floor(metrics.height / (rowHeight + GRID_COLUMNS.gapRem * metrics.rem))) : 4, gridWidth: metrics.width, viewportRef };
}
