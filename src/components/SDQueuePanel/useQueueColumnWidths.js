import { useRef, useState } from 'react';
import { KEYS, read, write } from '../../store/persistentSettings';

export const QUEUE_COLUMNS = [
  { id: 'type', label: 'Type', defaultWidth: 76, minWidth: 62, grow: 0.2 },
  { id: 'name', label: 'Nom', defaultWidth: 220, minWidth: 130, grow: 1.3 },
  { id: 'target', label: 'Destination', defaultWidth: 190, minWidth: 92, grow: 1 },
  { id: 'result', label: 'Résultat', defaultWidth: 300, minWidth: 130, grow: 1.6 },
  { id: 'status', label: 'Statut', defaultWidth: 96, minWidth: 82, grow: 0.25 },
  { id: 'usage', label: 'Usage', defaultWidth: 100, minWidth: 76, grow: 0.25 },
  { id: 'date', label: 'Date', defaultWidth: 92, minWidth: 72, grow: 0.2 },
  { id: 'actions', label: '', defaultWidth: 58, minWidth: 48, grow: 0 },
];

const RESIZABLE_COLUMNS = QUEUE_COLUMNS.filter((col) => col.id !== 'actions');
const DEFAULT_COL_WIDTHS = Object.fromEntries(QUEUE_COLUMNS.map((col) => [col.id, col.defaultWidth]));
const GRID_GAP = 8;
const GRID_OUTER_PADDING = 44;

function clampWidth(col, width) {
  const numeric = Number(width);
  return Math.max(col.minWidth, Number.isFinite(numeric) ? numeric : col.defaultWidth);
}

function loadQueueColWidths() {
  const saved = read(KEYS.AI_QUEUE_COL_WIDTHS, { parse: JSON.parse });
  if (!saved || Array.isArray(saved)) return { ...DEFAULT_COL_WIDTHS };
  const next = { ...DEFAULT_COL_WIDTHS };
  for (const col of QUEUE_COLUMNS) {
    if (saved[col.id] != null) next[col.id] = clampWidth(col, saved[col.id]);
  }
  return next;
}

function fitWidthsToContainer(widths, containerWidth) {
  const next = Object.fromEntries(QUEUE_COLUMNS.map((col) => [col.id, clampWidth(col, widths[col.id])]));
  const contentWidth = Math.max(0, (containerWidth || 0) - GRID_OUTER_PADDING);
  if (!contentWidth) return next;

  const gapTotal = GRID_GAP * (QUEUE_COLUMNS.length - 1);
  const widthTotal = () => QUEUE_COLUMNS.reduce((sum, col) => sum + next[col.id], gapTotal);
  let delta = contentWidth - widthTotal();

  if (delta > 0) {
    const growTotal = RESIZABLE_COLUMNS.reduce((sum, col) => sum + col.grow, 0);
    if (growTotal > 0) {
      for (const col of RESIZABLE_COLUMNS) {
        next[col.id] += delta * (col.grow / growTotal);
      }
    }
    return next;
  }

  let remaining = -delta;
  let shrinkable = RESIZABLE_COLUMNS.filter((col) => next[col.id] > col.minWidth);
  while (remaining > 0.5 && shrinkable.length > 0) {
    const available = shrinkable.reduce((sum, col) => sum + (next[col.id] - col.minWidth), 0);
    if (available <= 0) break;
    const consumed = Math.min(remaining, available);
    for (const col of shrinkable) {
      const share = consumed * ((next[col.id] - col.minWidth) / available);
      next[col.id] = Math.max(col.minWidth, next[col.id] - share);
    }
    remaining -= consumed;
    shrinkable = shrinkable.filter((col) => next[col.id] > col.minWidth + 0.5);
  }
  return next;
}

export function resolveQueueGrid(widths, containerWidth) {
  const fitted = fitWidthsToContainer(widths, containerWidth);
  const gridWidth = QUEUE_COLUMNS.reduce(
    (sum, col) => sum + Math.round(fitted[col.id]),
    GRID_GAP * (QUEUE_COLUMNS.length - 1),
  );

  return {
    grid: QUEUE_COLUMNS.map((col) => `${Math.round(fitted[col.id])}px`).join(' '),
    minWidth: `${gridWidth + GRID_OUTER_PADDING}px`,
    widths: fitted,
  };
}

export function useQueueColumnWidths() {
  const [colWidths, setColWidthsState] = useState(loadQueueColWidths);
  const colWidthsRef = useRef(colWidths);

  function setColWidths(newWidths) {
    colWidthsRef.current = newWidths;
    setColWidthsState(newWidths);
  }

  function persistColWidths() {
    write(KEYS.AI_QUEUE_COL_WIDTHS, colWidthsRef.current, { serialize: JSON.stringify });
  }

  return { colWidths, colWidthsRef, setColWidths, persistColWidths };
}
