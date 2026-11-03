// List rows use rem; card rows follow the measured card width at a fixed aspect ratio.
// The same dimensions drive the DOM and windowing, including browser zoom.
// Expanded exemplars have a separate fixed, internally scrolling slot.
// Five neighbouring rows on each side preload covers while keeping DOM bounded.
export const WINDOW_MARGIN = 5;
export const WINDOW_HEIGHTS = Object.freeze({ list: 2.75 });
// Existing 27-inch measurement: 2530px grid, eight cards, seven 16px gaps,
// and 17.5rem height at a 16px root. Preserve that shape at every density.
export const CARD_ASPECT_RATIO = ((2530 - 7 * 16) / 8) / (17.5 * 16);
export const CARD_DENSITIES = Object.freeze([
  { id: 'compact', cardsPerWindow: 10, labelKey: 'catalogue:toolbar.density.compact' },
  { id: 'normal', cardsPerWindow: 8, labelKey: 'catalogue:toolbar.density.normal' },
  { id: 'large', cardsPerWindow: 6, labelKey: 'catalogue:toolbar.density.large' },
]);
export function normalizeCardDensity(value) {
  return CARD_DENSITIES.some(level => level.id === value) ? value : 'normal';
}
export function cardsPerWindow(density) {
  return CARD_DENSITIES.find(level => level.id === normalizeCardDensity(density)).cardsPerWindow;
}
// Column rule shared with CardGridView CSS variables. A card is comfortable at about
// 1/8 of the window width (`cardsPerWindow`), so opening a side panel drops columns
// instead of stretching cards; `minCardRem` is the floor in narrow windows.
// The standalone grid uses a fixed 16px gap; the virtual grid uses one root rem.
export const GRID_COLUMNS = Object.freeze({ minCardRem: 11, gapRem: 1, cardsPerWindow: 8, standaloneGapPx: 16 });
// Without `windowWidth` (tests, standalone bench) the grid is assumed to span the whole window.
export function gridColumnCount({ width, rem, windowWidth = width, density = 'normal' }) {
  const fit = Math.max(1, Math.floor((width + GRID_COLUMNS.gapRem * rem) / ((GRID_COLUMNS.minCardRem + GRID_COLUMNS.gapRem) * rem)));
  const wanted = windowWidth > 0 ? Math.max(1, Math.round(cardsPerWindow(density) * width / windowWidth)) : cardsPerWindow(density);
  return Math.min(wanted, fit);
}
export function gridCardHeight({ width, rem, columns }) {
  return Math.max(0, (width - (columns - 1) * GRID_COLUMNS.gapRem * rem) / columns) / CARD_ASPECT_RATIO;
}
export function windowLayout({ count, columns = 1, rowHeight, gap = 0, expanded = [], expansionHeight = 0 }) {
  const rows = Math.ceil(count / columns);
  const expandedRows = new Set(expanded.map(index => Math.floor(index / columns)));
  const offsets = [0];
  for (let row = 0; row < rows; row++) offsets.push(offsets[row] + rowHeight + (expandedRows.has(row) ? expansionHeight : 0) + gap);
  return { count, columns, rows, offsets, total: Math.max(0, offsets[rows] - gap) };
}
function rowAt(offsets, position) {
  let low = 0, high = offsets.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if (offsets[middle] <= position) low = middle; else high = middle - 1;
  }
  return Math.min(low, offsets.length - 2);
}
function windowRows(layout, scrollTop, viewport, margin) {
  const top = Math.max(0, Math.min(scrollTop, Math.max(0, layout.total - viewport)));
  return { first: Math.max(0, rowAt(layout.offsets, top) - margin), last: Math.min(layout.rows, rowAt(layout.offsets, top + viewport) + margin + 1) };
}
/** Two scroll positions render the same rows: scrolling between them needs no new render. */
export function sameWindowRows(layout, a, b, viewport, margin = WINDOW_MARGIN) {
  if (!layout.rows) return true;
  const x = windowRows(layout, a, viewport, margin), y = windowRows(layout, b, viewport, margin);
  return x.first === y.first && x.last === y.last;
}
export function catalogueWindow(layout, { scrollTop = 0, viewport = 720, margin = WINDOW_MARGIN, pinned = [] } = {}) {
  if (!layout.rows) return { segments: [], first: 0, last: 0, total: 0, visibleIndices: [] };
  const { first, last } = windowRows(layout, scrollTop, viewport, margin);
  const rows = new Set(Array.from({ length: last - first }, (_, i) => first + i));
  for (const index of pinned) if (index >= 0 && index < layout.count) rows.add(Math.floor(index / layout.columns));
  const segments = [];
  let cursor = 0;
  for (const row of [...rows].sort((a,b)=>a-b)) {
    if (row > cursor) segments.push({ kind: 'spacer', height: layout.offsets[row] - layout.offsets[cursor] });
    segments.push({ kind: 'row', row, start: row * layout.columns, end: Math.min((row + 1) * layout.columns, layout.count), height: Math.min(layout.offsets[row + 1], layout.total) - layout.offsets[row] });
    cursor = row + 1;
  }
  if (cursor < layout.rows) segments.push({ kind: 'spacer', height: Math.max(0, layout.total - layout.offsets[cursor]) });
  return { segments, first, last, total: layout.total,
    visibleIndices: Array.from({ length: Math.min(last*layout.columns,layout.count)-first*layout.columns },(_,i)=>first*layout.columns+i) };
}
export function scrollToIndex(layout, index, scrollTop, viewport) {
  if (index < 0 || index >= layout.count) return scrollTop;
  const row = Math.floor(index / layout.columns);
  const start = layout.offsets[row], end = layout.offsets[row+1];
  return start < scrollTop ? start : end > scrollTop + viewport ? Math.max(0,end-viewport) : scrollTop;
}

export function windowAnchor(layout, ids, scrollTop) {
  if (!layout.rows) return null;
  const row = Math.max(0,rowAt(layout.offsets,scrollTop));
  return { id:ids[row*layout.columns], offset:scrollTop-layout.offsets[row] };
}
export function restoreWindowAnchor(layout, ids, anchor, fallback = 0) {
  const index=anchor ? ids.indexOf(anchor.id) : -1;
  return index < 0 ? Math.max(0,Math.min(fallback,layout.total))
    : Math.max(0,layout.offsets[Math.floor(index/layout.columns)]+anchor.offset);
}
